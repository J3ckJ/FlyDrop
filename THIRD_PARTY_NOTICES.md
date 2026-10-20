# Сторонние компоненты FlyDrop 0.4.0

Приложение само не запускает PowerShell, cmd, cscript или wscript. Конвертер ниже — отдельный exe, который стартует напрямую (`shell: false`, `windowsHide: true`). Если файла нет, оригинал фото или видео всё равно сохраняется.

## ffmpeg

- Сборка: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `ffmpeg-master-latest-win64-lgpl` (ветка LGPL, не GPL).
- Лицензия: LGPL-2.1-or-later. Текст: <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.
- Исходники этой сборки публикует BtbN вместе с релизом. Бинарник можно заменить своим: положите `ffmpeg.exe` (и его DLL, если сборка shared) в `resources/converters` рядом с приложением или задайте `FLYDROP_FFMPEG`.
- В сборку не входит GPL-кодек libx264. H.264 берётся из `h264_mf` (Media Foundation Windows) или `libopenh264`.
- ProRes Proxy (`prores_ks`, профиль 0, 1080p) — реализация ffmpeg, не SDK Apple. ProRes — товарный знак Apple Inc. FlyDrop с Apple не связан.

## libheif

- Лицензия: LGPL-3.0-or-later. <https://www.gnu.org/licenses/lgpl-3.0.html>.
- `heif-convert` необязателен. Если он лежит рядом (`FLYDROP_HEIF` или `heif-convert.exe` в `resources/converters`), HEIC→JPG идёт через него. Иначе ту же работу пробует ffmpeg с `-map_metadata 0`. Оригинал HEIC остаётся в папке «Оригиналы».

## OpenH264

- Лицензия: BSD-2-Clause. Домашняя страница Cisco: <https://www.openh264.org/>.
- Патентная лицензия MPEG-LA на бинарник OpenH264 распространяется Cisco отдельно. Мы не пересобираем OpenH264 и не прячем его внутри скрипта.

## Шрифты интерфейса

- Inter, SIL Open Font License 1.1. Файл `public/fonts/Inter-OFL.txt`.
- JetBrains Mono, SIL Open Font License 1.1. Файл `public/fonts/OFL.txt`.

## Прочее

Зависимости Node (`qrcode`, `@peculiar/x509`, Electron) остаются как в 0.3.0. Их лицензии — в `node_modules` после `npm ci` и в уведомлениях electron-builder.
