import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { describeAdapters, parseDarwinRoute, parseLinuxProcRoute, parseWindowsRoutePrint } from '../src/lan.js';
import { ensureWindowsFirewall, firewallAllowsPort, planFirewall } from '../src/firewall.js';

const owner = {
  'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.19.224.1', mac: '00:15:5d:00:00:01' }],
  'Ethernet 2': [{ family: 'IPv4', internal: false, address: '169.254.64.40', mac: '00:15:5d:11:22:33' }],
  'vEthernet (DockerNAT)': [{ family: 'IPv4', internal: false, address: '192.168.65.138', mac: '00:15:5d:aa:bb:cc' }],
  'VMware Network Adapter VMnet8': [{ family: 'IPv4', internal: false, address: '192.168.240.1', mac: '00:50:56:c0:00:08' }],
  'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.24', mac: 'b8:27:eb:00:00:02' }],
};

test('the iPhone address is the Wi-Fi adapter that owns the default gateway', () => {
  const routes = parseWindowsRoutePrint(`
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.24     25
        172.19.224.0    255.255.240.0         On-link      172.19.224.1    271
`);
  const lan = describeAdapters(owner, routes);
  assert.deepEqual(lan.phone.map(item => item.address), ['192.168.1.24']);
  assert.equal(lan.phone[0].name, 'Wi-Fi');
  assert.equal(lan.gateway, true);
  assert.deepEqual(lan.skipped.map(item => item.address).sort(), ['169.254.64.40', '172.19.224.1', '192.168.240.1', '192.168.65.138']);
});

test('a lower-metric Ethernet route wins over Wi-Fi, and a virtual default route is ignored', () => {
  const lan = describeAdapters({
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.24', mac: 'aa:aa:aa:aa:aa:aa' }],
    Ethernet: [{ family: 'IPv4', internal: false, address: '10.0.0.5', mac: 'bb:bb:bb:bb:bb:bb' }],
    'Hyper-V Virtual Ethernet Adapter': [{ family: 'IPv4', internal: false, address: '172.31.0.1', mac: 'cc:cc:cc:cc:cc:cc' }],
  }, [
    { address: '172.31.0.1', metric: 1, name: '', gateway: '172.31.0.2' },
    { address: '10.0.0.5', metric: 10, name: '', gateway: '10.0.0.1' },
    { address: '192.168.1.24', metric: 40, name: '', gateway: '192.168.1.1' },
  ]);
  assert.deepEqual(lan.phone.map(item => `${item.name} ${item.address}`), ['Ethernet 10.0.0.5', 'Wi-Fi 192.168.1.24']);
  const onlyVirtualRoute = describeAdapters(owner, [{ name: 'vEthernet (WSL)', metric: 0, address: '172.19.224.1', gateway: '172.19.224.2' }]);
  assert.equal(onlyVirtualRoute.phone[0].name, 'Wi-Fi');
  assert.equal(onlyVirtualRoute.foreignGateway, true);
});

test('linux and macOS default routes parse to the gateway interface', () => {
  const linux = parseLinuxProcRoute('Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nenp0s3\t00000000\t01001EAC\t0003\t0\t0\t0\t00000000\ndocker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n');
  assert.deepEqual(linux, [{ name: 'enp0s3', gateway: '172.30.0.1', address: '', metric: 0 }]);
  const darwin = parseDarwinRoute('   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n');
  assert.equal(darwin[0].name, 'en0');
  assert.equal(darwin[0].gateway, '192.168.1.1');
});

test('public Wi-Fi does not get a firewall hole, private Wi-Fi does', async () => {
  const rules = {
    4720: 'Rule Name: Old\r\nEnabled: Yes\r\nProfiles: Public\r\nAction: Allow\r\nLocalPort: 4720\r\n',
    4318: '',
  };
  const publicPlan = planFirewall({
    ports: [4720, 4318],
    adapterName: 'Wi-Fi',
    profiles: [{ name: 'Wi-Fi', category: 'Public' }],
    rules,
  });
  assert.equal(publicPlan.apply, false);
  assert.match(publicPlan.notes.join('\n'), /общедоступн/);
  assert.equal(publicPlan.command, undefined);

  const result = await ensureWindowsFirewall({
    ports: [4720, 4318],
    adapterName: 'Wi-Fi',
    platform: 'win32',
  });
  assert.equal(result.applied, false);
  assert.match(result.notes.join('\n'), /pult\.exe/);
  assert.equal(firewallAllowsPort('Rule Name: Pult\r\nEnabled: Yes\r\nProfiles: Private\r\nAction: Allow\r\nLocalPort: 4720\r\n', 4720), true);
  assert.equal(firewallAllowsPort(rules[4720], 4720), false);
});

test('the console QR encodes the iPhone URL', async () => {
  const url = 'https://192.168.1.24:4720/';
  const qr = await QRCode.toString(url, { type: 'utf8', errorCorrectionLevel: 'M', margin: 2 });
  assert.ok(qr.split('\n').length > 8);
  assert.match(qr, /█/);
});
