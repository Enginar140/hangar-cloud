# Hangar Cloud

[English](README.md) · **Türkçe**

[Hangar](https://github.com/Enginar140/hangar)'ın ArduPilot SITL + Gazebo simülasyonlarını bir
Linux makinede (evdeki sunucu, laboratuvar bilgisayarı ya da küçük bir VPS) çalıştırır ve
Windows dahil her bilgisayardan tarayıcıyla kullanmanı sağlar. Canlı **3D görüntü**, araç
telemetrisi ve komutları, senaryolar, loglar ve QGroundControl / Mission Planner bağlantı
bilgileri tek sayfada.

![Tarayıcıda arkasından görülen, uçan bir quadcopter](docs/images/chase.jpg)

> **Durum: erken sürüm (0.1).** Aynı anda tek kullanıcı. 3D görüntü, komutlar, senaryolar,
> loglar ve MAVLink çıkışları çalışıyor. Tarayıcıda kamera görüntüsü, parametre düzenleyici ve
> harita sırada ([Yol haritası](#yol-haritası)).

## Nasıl çalışır

```
Tarayıcı (Windows, Mac, Linux, tablet)            Linux makine
  3D görüntü (Three.js) ◄── WebSocket ────────  hangar-cloud
  araçlar, komutlar, loglar ◄── HTTP ─────────    ├─ Hangar: Gazebo + ArduPilot SITL'ler + MAVLink router
                                                  └─ Gazebo köprüsü: sahne ve konumlar (gz-transport)
QGroundControl / script ◄──── MAVLink TCP ────  Bağlan sekmesinde eklediğin çıkışlar
```

- **3D görüntüyü sunucu değil, senin tarayıcın çizer.** Küçük bir köprü Gazebo'dan sahneyi
  (modeller, mesh'ler, arazi) ve konumları okur, saniyede yaklaşık 30 kez WebSocket ile gönderir.
  Three.js bunları senin bilgisayarının GPU'sunda çizer. Gazebo sunucuda penceresiz çalışır, bu
  yüzden ekran kartı olmayan bir makine bunun için yeterlidir.
- Mesh'ler (`.dae`, `.obj`, `.stl`, `.gltf`), dokular ve arazi sunucudan yüklenir. Sunucu yalnızca
  o anki sahneye ait dosyaları verir.
- [hangar-earth](https://github.com/Enginar140/hangar-earth) dünyaları gerçek arazileri ve uydu
  görüntüleriyle, Gazebo'nun kullandığı yüksekliklerin aynısıyla görünür.
- Gerisi (Gazebo ve SITL'leri başlatmak, portlar, MAVLink) Hangar'ın kendi kodudur. Bir senaryo
  terminal arayüzünde de tarayıcıda da aynı davranır.

| | |
|---|---|
| ![Pistte bir sabit kanat ve quadcopter, quadcopter'ın izi ile](docs/images/overview.jpg) | ![Aynı sayfa telefonda](docs/images/phone.jpg) |

## Gerekenler

Linux makinede:

- **Hangar** kurulu ve `hangar doctor` sorunsuz olmalı: ArduPilot SITL, Gazebo Harmonic ve araç
  modelleri. [Hangar'ın kurulum rehberine](https://github.com/Enginar140/hangar/blob/main/README.tr.md#kurulum) bak.
- 3D görüntü için **Gazebo'nun Python bağlantıları**. Ubuntu'da Gazebo Harmonic ile gelir
  (`python3-gz-transport13`). Yoksa diğer her şey yine çalışır, sayfa 3D görüntünün kapalı olduğunu
  söyler.
- [uv](https://docs.astral.sh/uv/).

Kendi bilgisayarında: WebGL destekli güncel bir tarayıcı (Chrome, Edge, Firefox, Safari).

## Kurulum ve çalıştırma

```bash
uv tool install git+https://github.com/Enginar140/hangar-cloud
hangar-cloud serve
```

Giriş anahtarı (token) içeren bir bağlantı yazar:

```
hangar-cloud 0.1.0
  open  http://127.0.0.1:8080/?token=6vQ...
```

Anahtar `~/.local/share/hangar/cloud/token` dosyasında saklanır, yeniden başlatınca değişmez.
`hangar-cloud token` anahtarı yazar, `hangar-cloud token --new` yenisini üretir (eski
bağlantılar çalışmaz olur).

### Başka bir bilgisayardan erişmek

Birini seç:

- **SSH tüneli** (hiçbir port açmadan, VPS için de olur):
  `ssh -L 8080:localhost:8080 sen@sunucu`, sonra kendi bilgisayarında
  `http://localhost:8080/?token=...` adresini aç. Windows'ta `ssh` PowerShell'de hazır gelir.
- **Ev ağı**: `hangar-cloud serve --host 0.0.0.0` ile çalıştır ve
  `http://<sunucu-ip>:8080/?token=...` adresini aç.
- **VPN** ([Tailscale](https://tailscale.com) ya da WireGuard): sunucu, yalnızca senin
  cihazlarının erişebildiği özel bir adres alır. QGroundControl bağlamanın da en güvenli yolu budur.
- **İnternette HTTPS**: `serve`'ü `127.0.0.1`'de bırak, önüne bir ters vekil (reverse proxy) koy.
  [Caddy](https://caddyserver.com) ve bir alan adıyla şu `Caddyfile` yeterlidir (sertifikayı
  Caddy kendisi alır):

  ```
  sim.ornek.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```

### Sürekli çalışsın

Bir systemd kullanıcı servisi makineyle birlikte başlatır:

```ini
# ~/.config/systemd/user/hangar-cloud.service
[Unit]
Description=Hangar Cloud

[Service]
ExecStart=%h/.local/bin/hangar-cloud serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now hangar-cloud
loginctl enable-linger $USER   # oturumu kapatınca da çalışmaya devam etsin
```

## Kullanım

- Üstte **Start / Stop**. Çubuk simülasyon hızını gösterir (×1 = gerçek zaman). ArduPilot'un arm
  olabilmesi için bir süre *simülasyon* zamanı geçmesi gerekir, yavaş bir simülasyonda bu daha
  uzun sürer.
- **Vehicles (Araçlar)**: her araç için bir kart: irtifa, hız, yön, batarya, arm'a hazır olma,
  GPS ve simülasyon hızı. Uçuş modunu aracın kendi listesinden seç, arm/disarm et, yazdığın
  irtifaya kalkış yap, RTL, iniş; geri kalan her şey için komut satırı:
  `param set WPNAV_SPEED 800`.
- **3D görüntü**: sürükleyerek etrafında dön, sağ tıkla sürükleyerek kaydır, tekerlekle yakınlaş.
  Bir araca (ya da etiketine, kartına) tıklayınca seçilir; üstteki panel irtifasını, hızını,
  tırmanma hızını, yönünü ve bataryasını gösterir. Kamera modları: **Free** (serbest),
  **Follow** (araç hareket ederken etrafında döner), **Chase** (arkasından) ve **Top** (yukarıdan,
  kuzey yukarıda); `1`-`4` tuşları, serbest için `Esc`. Her aracın kendi rengi ve uçtuğu yerin
  **izi** vardır (*Trails* kapatır, çöp kutusu temizler). *Fit* tüm araçları gösterir.
- **Scenario (Senaryo)**: kayıtlı ya da örnek bir senaryo yükle, YAML'ını düzenle
  ([Hangar'ınkiyle](https://github.com/Enginar140/hangar/blob/main/README.tr.md#senaryo-dosyası) aynı
  biçim), uygula ve kaydet. Sorunlar başlatmadan önce gösterilir.
- **Logs (Loglar)**: Hangar'ın yazdığı her şey, araçların mesajları dahil (PreArm hataları, mod
  değişiklikleri), filtrelerle.
- **Connect (Bağlan)**: MAVLink çıkışları, simülasyon çalışırken değiştirilebilir. Windows'ta
  QGroundControl ya da Mission Planner için `tcpin:0.0.0.0:5790` ekle ve TCP `sunucu:5790`'a
  bağlan. Her aracın kendi script'lerin için iki boş SITL portu da vardır (orada listelenir).

## Güvenlik

Anahtar, makinedeki simülasyonların tam kontrolünü verir: şifre gibi sakla. Giriş çerezi
`HttpOnly` ve `SameSite=Strict`'tir, başka sitelerden gelen istekler reddedilir. Bağlantı kendi
ağının dışına çıkıyorsa HTTPS (ya da SSH tüneli veya VPN) kullan. MAVLink portlarını internete
açma; onlar için doğru araç VPN'dir.

## Yol haritası

1. **Tarayıcıda kamera görüntüsü**: WebRTC ile ([MediaMTX](https://github.com/bluenviron/mediamtx)
   üzerinden), başka bilgisayarlardaki OpenCV için de RTSP.
2. **Parametre düzenleyici** ve araçları, görevleri gösteren bir **harita**.
3. Gazebo, ArduPilot ve modellerle **Docker imajı**: VPS'te ya da Windows'ta (WSL2'li Docker
   Desktop) tek komutla çalıştırmak için.
4. Birden çok kullanıcı, her birinin kendi simülasyonları.

## Lisanslar

Hangar Cloud [MIT](LICENSE) lisanslıdır. İçinde [three.js](https://threejs.org) bulunur (MIT,
[lisans](src/hangar_cloud/web/vendor/three/LICENSE)). Kendisi başka hiçbir şey kurmaz: ArduPilot
(GPL-3.0), Gazebo (Apache-2.0) ve araç modelleri Hangar üzerinden gelir; Hangar bir şey indirmeden
önce sorar ve lisansını gösterir. ArduPilot ve Gazebo ayrı programlar olarak çalışır. Böyle bir
sunucuyu başkalarına açarsan, gösterdiğin modellerin ve dünyaların lisanslarına bak; bazı örnek
modeller lisans belirtmiyor.

## Geliştirme

```bash
git clone https://github.com/Enginar140/hangar-cloud && cd hangar-cloud
uv sync
uv run pytest -q
uv run ruff check src tests scripts
uv run hangar-cloud serve
```

Tarayıcı kodu derleme adımı olmayan düz ES modülleridir: `src/hangar_cloud/web/*.js` dosyalarını
düzenleyip sayfayı yenilemen yeterli.
