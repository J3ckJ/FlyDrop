import { randomUUID } from 'node:crypto';

function xml(value) {
  return String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

export function shortcutPlist({ url, token, name = 'В FlyDrop' }) {
  if (!/^https:\/\/[^"'\s]+\/api\/buffer\/ingest$/.test(url)) throw new Error('Команда принимает только HTTPS-адрес FlyDrop');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Ключ команды некорректен');
  const clip = randomUUID().toUpperCase();
  const post = randomUUID().toUpperCase();
  const show = randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WFWorkflowName</key><string>${xml(name)}</string>
<key>WFWorkflowClientVersion</key><string>1113</string>
<key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
<key>WFWorkflowTypes</key><array><string>NCWidget</string><string>Watch</string></array>
<key>WFWorkflowIcon</key><dict><key>WFWorkflowIconStartColor</key><integer>431817727</integer><key>WFWorkflowIconGlyphNumber</key><integer>59511</integer></dict>
<key>WFWorkflowActions</key><array>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.getclipboard</string><key>WFWorkflowActionParameters</key><dict/><key>WFWorkflowActionUUID</key><string>${clip}</string></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string><key>WFWorkflowActionUUID</key><string>${post}</string><key>WFWorkflowActionParameters</key><dict>
<key>WFHTTPMethod</key><string>POST</string>
<key>WFURL</key><string>${xml(url)}</string>
<key>WFHTTPBodyType</key><string>File</string>
<key>ShowHeaders</key><true/>
<key>WFHTTPHeaders</key><dict><key>Value</key><dict><key>WFDictionaryFieldValueItems</key><array>
<dict><key>WFItemType</key><integer>0</integer><key>WFKey</key><dict><key>Value</key><dict><key>string</key><string>Authorization</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict><key>WFValue</key><dict><key>Value</key><dict><key>string</key><string>Bearer ${xml(token)}</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict></dict>
<dict><key>WFItemType</key><integer>0</integer><key>WFKey</key><dict><key>Value</key><dict><key>string</key><string>X-FlyDrop-Source</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict><key>WFValue</key><dict><key>Value</key><dict><key>string</key><string>backtap</string></dict><key>WFSerializationType</key><string>WFTextTokenString</string></dict></dict>
</array></dict><key>WFSerializationType</key><string>WFDictionaryFieldValue</string></dict>
<key>WFRequestVariable</key><dict><key>Value</key><dict><key>OutputUUID</key><string>${clip}</string><key>Type</key><string>ActionOutput</string></dict><key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict>
</dict></dict>
<dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.showresult</string><key>WFWorkflowActionUUID</key><string>${show}</string><key>WFWorkflowActionParameters</key><dict><key>Text</key><dict><key>Value</key><dict><key>OutputUUID</key><string>${post}</string><key>Type</key><string>ActionOutput</string></dict><key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict></dict></dict>
</array></dict></plist>`;
}
