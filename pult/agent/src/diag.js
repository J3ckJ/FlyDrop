import http from 'node:http';

export function windowsRefusal() {
  return [
    '════════════════════════════════════════',
    'ПУЛЬТ НЕ ЗАПУЩЕН. ПОРТЫ НЕ ОТКРЫТЫ.',
    'iPhone НИЧЕГО НЕ ОТКРОЕТ: эта команда ничего не слушает.',
    'node src\\index.js на Windows сразу завершается.',
    'Дважды щёлкните pult.exe. Не запускайте node.',
    'Сборка: артефакт pult-windows-amd64 у успешного запуска «Pult Windows».',
    '════════════════════════════════════════',
  ].join('\n');
}

export function probePing(url, timeoutMs = 2000) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: response.statusCode === 200 && body.startsWith('ok'), status: response.statusCode, body });
      });
    });
    request.on('error', error => resolve({ ok: false, error: error.message }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, error: 'таймаут' });
    });
  });
}

export function explainReachability(facts) {
  const lines = ['', '  Проверка с этого компьютера:'];
  lines.push(`  • Привязка HTTPS: ${facts.bindHTTPS || 'нет'}`);
  lines.push(`  • Привязка HTTP: ${facts.bindHTTP || 'нет'}`);
  const httpsAll = String(facts.bindHTTPS || '').includes('0.0.0.0');
  const httpAll = String(facts.bindHTTP || '').includes('0.0.0.0');
  lines.push(httpsAll && httpAll
    ? '  • Это 0.0.0.0, не localhost: порт открыт на всех адаптерах IPv4.'
    : '  • Сервер слушает не все интерфейсы IPv4. iPhone по адресу Wi-Fi до него не дойдёт.');
  if (!facts.address) lines.push('  • Адреса Wi-Fi или Ethernet нет. iPhone открывать нечего.');
  else lines.push(`  • Адрес для iPhone: ${facts.address} · ${facts.adapter || 'адаптер'}`);
  if (facts.hotspot) lines.push('  • Компьютер уже в сети точки доступа iPhone. Откройте http-адрес на этом телефоне.');
  const ping = facts.address ? `http://${facts.address}:${facts.httpPort}/ping` : '';
  if (!ping) lines.push('  • Запрос на свой адрес не выполнялся: адреса нет.');
  else if (facts.probeOK) lines.push(`  • Запрос на ${ping}: ok`);
  else {
    lines.push(`  • Запрос на ${ping} не прошёл: ${facts.probeError || 'нет ответа'}`);
    lines.push('  • Пока компьютер не открывает свой адрес, iPhone тоже не подключится.');
  }
  for (const note of facts.notes || []) lines.push(`  • ${note}`);
  lines.push(
    '',
    '  Если Safari пишет, что страницу открыть не удалось, запрос до компьютера не дошёл.',
    '  Проверка выше идёт с самого компьютера. Путь с телефона другой.',
    '  Kaspersky (сетевой экран и «Мониторинг сетевых атак») может отбрасывать входящие на порт Пульта, даже когда правило Windows есть. Защиту и контроль программ не отключайте. Если всплыло окно про pult.exe — разрешите ему входящие. Если окна не было, в отчёте сетевого экрана Kaspersky разрешите pult.exe сеть.',
    '  Корпоративный Wi-Fi часто изолирует клиентов: телефон и компьютер в одной сети друг друга не видят. Пульт эту настройку точки доступа не обходит.',
    '',
    '  Запасной путь — точка доступа iPhone. Компьютер сам подключается к телефону:',
    '  1. iPhone: Настройки → Режим модема → разрешить другим.',
    '  2. Компьютер: подключиться к этой сети Wi-Fi.',
    '  3. Параметры Windows → Сеть → эта сеть → Частная. Общедоступную сеть Пульт не открывает.',
    '  4. Новый адрес 172.20.10.x появится в этом окне. Если нет — запустите программу ещё раз.',
    '  5. На том же iPhone сначала откройте http://172.20.10.x:4721/setup, затем http://172.20.10.x:4721/ping — на экране ok.',
    '',
  );
  return lines;
}
