export function reportText(stats) {
  const copied = stats.copied || 0;
  const lines = [
    'FlyDrop · выгрузка',
    `Скопировано ${copied}`,
    `Пропущено ${stats.skipped || 0}`,
    `Ошибок ${stats.errors || 0}`,
    `Целостность: ${stats.verified || 0} из ${copied} совпали по SHA-256`,
    'Проверено после записи на диск, а не в памяти',
  ];
  const resumes = stats.resumes || [];
  if (resumes.length) {
    lines.push(`${resumes.length} обрыва связи — докачано с места`);
    for (const line of resumes) lines.push(`- ${line}`);
  }
  if (stats.folders?.length) lines.push(`События: ${stats.folders.join(', ')}`);
  lines.push(`Прокси: ${stats.proxies || 0}`);
  lines.push(`JPG: ${stats.jpg || 0}`);
  if (stats.bytes) lines.push(`Объём: ${stats.bytes} байт`);
  return `${lines.join('\n')}\n`;
}

export function notificationLine(stats) {
  return `Скопировано ${stats.copied || 0}, пропущено ${stats.skipped || 0}`;
}

export function partition(files, known) {
  const accept = [];
  const skip = [];
  const seen = new Set();
  for (const file of files) {
    const hash = String(file.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash) || known.has(hash) || seen.has(hash)) skip.push({ ...file, sha256: hash });
    else { seen.add(hash); accept.push({ ...file, sha256: hash }); }
  }
  return { accept, skip };
}
