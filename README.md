# MultiStream Viewer

Tek pencerede **16'ya kadar** Twitch, Kick ve YouTube canlı yayınını aynı anda izlemeye yarayan Windows masaüstü uygulaması (Electron).

## Özellikler
- Twitch, Kick ve YouTube linki (veya `twitch.tv/kanal`, `kick.com/kanal`, `yt:ID` kısaltmaları) ile yayın ekleme
- Birden fazla linki aynı anda yapıştırma (en fazla 16 yayın)
- Her yayın için ayrı ses kontrolü, **Tümünü sessize al** (Ctrl+M), tümünü yenile / temizle
- Yayın listesi kapatıp açınca korunur
- Güvenlik: yalnızca izin verilen oynatıcı alanlarına (player.twitch.tv, player.kick.com, YouTube) izin verilir; sıkı CSP

## İndirme
[Releases](../../releases) sayfasından `MultiStream-Viewer.zip` dosyasını indirip açın ve `MultiStream Viewer.exe` dosyasını çalıştırın. Kurulum gerekmez.

## Kaynaktan çalıştırma
```bash
npm install --save-dev electron
npx electron .
```

## Yapı
- `src/main/` — Electron ana süreç ve preload
- `src/renderer/` — arayüz (HTML/CSS/JS)
- `src/shared/parse.js` — link ayrıştırma ve doğrulama

## Lisans
MIT — bkz. [LICENSE](LICENSE). Uygulama paketi Electron/Chromium içerir; lisansları release içindeki `LICENSE.electron.txt` ve `LICENSES.chromium.html` dosyalarındadır.
