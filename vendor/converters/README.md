# Конвертеры

Сюда `scripts/fetch-converters.mjs` на Windows кладёт `ffmpeg.exe` сборки BtbN LGPL и, если удалось скачать, `heif-convert.exe`.

Эти файлы не коммитятся. Упаковка копирует папку в `resources/converters` рядом с приложением, не внутрь asar: из asar exe не запускается.

Лицензии: `THIRD_PARTY_NOTICES.md`.
