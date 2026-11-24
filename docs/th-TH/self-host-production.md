# Deploy บน production

[English](../self-host-production.md) | ไทย

รัน Rakazo บนเซิร์ฟเวอร์สาธารณะ พร้อม HTTPS อัตโนมัติ โฮสต์ที่ผ่านการ hardening และ deploy แบบไม่มี downtime

สำหรับคลัสเตอร์ node เดียว ดู [การติดตั้ง Kubernetes / k3s](../self-host-kubernetes.md) การวาง login gate แบบใช้ cookie ไว้หน้า deployment ใดก็ตาม ต้องใช้ [screen routing ที่รู้จัก capability](../self-host-kubernetes.md#add-a-login-gate-without-breaking-the-computer) ด้วย เพราะ iframe ของหน้าจออาจไม่มี cookie ชั้นนอกแม้ผู้ใช้ลงชื่อเข้าใช้แล้ว

## Deploy บน VM เดียวแบบสาธารณะ

`infra/compose/docker-compose.prod.yml` รันผลิตภัณฑ์พร้อม Postgres, API, worker, เว็บแอป และ HTTPS อัตโนมัติผ่าน Caddy ใช้ E2B สำหรับ computer ของ bot VM จึงไม่เปิด Docker supervisor หรือ container ของเบราว์เซอร์ออกภายนอก ส่วน `infra/compose/docker-compose.prod.docker.yml` คือ overlay ที่เลือกเปิดได้ เพื่อรัน Docker computer บนเครื่องใน stack เดียวกัน (ดูด้านล่าง) updater sidecar ซึ่งมีสิทธิ์เทียบเท่า root เป็น profile ที่ต้องเลือกเปิดเองอย่างชัดเจน

ก่อน deploy ไปยังโฮสต์ Ubuntu ใหม่ ให้สร้างและตรวจสอบบัญชี `deploy` ที่ใช้ key อย่างเดียว แล้วรัน baseline การ hardening โฮสต์ซึ่งรันซ้ำได้ปลอดภัย สคริปต์จะปิดรหัสผ่าน SSH และการล็อกอินด้วย root จำกัดอัตรา SSH อนุญาตเฉพาะ SSH/HTTP/HTTPS ผ่าน UFW เปิด fail2ban, การอัปเดตความปลอดภัยอัตโนมัติ, AppArmor, audit rule และการป้องกัน kernel/เครือข่ายแบบระมัดระวัง รวมถึงทิ้งแพ็กเก็ต IPv4 TCP ขาเข้าที่มี IP options และปิด multipath TCP การอัปเกรดอัตโนมัติจะติดตั้งแพตช์ kernel แต่ไม่รีบูต จึงต้องรีบูตเองหลังอัปเดต kernel เปิดคอนโซลของผู้ให้บริการไว้จนกว่าการล็อกอิน SSH ใหม่จะสำเร็จหลังสคริปต์รีโหลด SSH

```bash
sudo --preserve-env=SSH_CONNECTION DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

โฮสต์ production ยังใช้ `infra/compose/docker-daemon.json` เพื่อเปิด live restore, จำกัดขนาด log ของ container บนเครื่อง, ตั้ง no-new-privileges เป็นค่าเริ่มต้น และใช้เส้นทาง NAT ของ kernel แทน userland proxy ของ Docker

1. ชี้ record `A`/`AAAA` เช่น `app.example.com` ไปที่ VM และอนุญาต TCP 80/443 กับ UDP 443 ขาเข้า ถ้าใช้ Cloudflare ให้เปิด proxy พร้อม TLS แบบ **Full (strict)** และคัดลอก `Caddyfile.cloudflare.example` ไปไว้ที่ path ที่ผู้ดูแลควบคุมนอก checkout สาธารณะ ตั้ง `CADDYFILE_PATH` เป็น absolute path นั้น ตัวอย่างจะทิ้ง request ของแอปที่ไม่ได้มาจาก [ช่วง IP ที่ Cloudflare เผยแพร่](https://www.cloudflare.com/ips/) ปรับช่วงเหล่านั้นให้ตรงทุกครั้งที่ Cloudflare ประกาศการเปลี่ยนแปลง Cloudflare Tunnel ใช้แทน listener เว็บสาธารณะได้
2. clone repository บน VM แล้วสร้าง `.env` ที่ root ด้วยค่าสำหรับ production เท่านั้น อย่างน้อยต้องตั้ง `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `OPENROUTER_API_KEY`, API key ของ sandbox provider ที่เลือก, `RAKAZO_HOST` และ origin สาธารณะทั้งสาม ตั้ง `RAKAZO_DEPLOY_DIR` เมื่อ checkout ไม่ได้อยู่ที่ค่าเริ่มต้นบน Linux คือ `/srv/rakazo` ใช้ค่าสุ่มที่ปลอดภัยใน URL สำหรับ credential ของฐานข้อมูล ถ้าเปิด profile `updater` ให้ตั้ง `RAKAZO_UPDATER_TOKEN` เฉพาะ (อย่างน้อย 32 ตัวอักษร) ที่ไม่ซ้ำกับ `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN` และ `SCREEN_PROXY_SECRET` ด้วย
3. จำกัดการสมัครด้วย allowlist ขณะที่บริการยังเป็นส่วนตัว:

```env
NODE_ENV=production
RAKAZO_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/rakazo/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
# e2b, novita, daytona, or boat
SANDBOX_PROVIDER=e2b
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/rakazo is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" in Upgrading.
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
# Optional: required only with `--profile updater`.
# RAKAZO_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. build image จาก checkout แล้วสตาร์ท stack จากนั้นตรวจ health endpoint สาธารณะ:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**การ deploy ครั้งแรกให้ build อย่า pull** `RAKAZO_IMAGE_TAG` มาเป็น `local` ซึ่งเป็น tag ที่ไม่มี registry ใดให้บริการ คำสั่งด้านบนจึง build `api`, `worker` และ `web` จาก checkout ที่เพิ่ง clone คำสั่งแบบเลือกเปิดใน [Updater sidecar](./self-host-upgrading.md#updater-sidecar) จะ build `updater` เมื่อจำเป็น

`/health` สาธารณะรายงานเพียงว่ายังทำงานอยู่ รายละเอียด runtime, sandbox และ revision อยู่บนพอร์ต API ที่ `/internal/health` ซึ่ง edge ไม่ได้ route ไป:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.text()).then(console.log)"
```

การส่ง `GIT_SHA` คือสิ่งที่ทำให้ `/internal/health` รายงาน `"revision"` image ที่ build บนเครื่องไม่มีทางอื่นที่จะรู้ commit ของตัวเอง image สำเร็จรูปจาก registry ฝังค่านี้ไว้ตอนเผยแพร่ การสลับไปใช้ release tag จึงไม่ต้องทำอะไรเพิ่ม container จะรายงาน revision ที่ image ถูก build มา ไม่ใช่ `GIT_SHA` ใน `.env`

เมื่อมี release เผยแพร่แล้ว คุณสลับโฮสต์นี้ไปใช้ image สำเร็จรูปได้โดยตั้ง `RAKAZO_IMAGE_TAG` เป็น release tag นั้น แล้วรัน `pull` ตามด้วย `up -d --wait --pull never` ข้อกำหนดของ tag ดูที่ [image และ tag ที่เผยแพร่](./self-host-upgrading.md#image-และ-tag-ที่เผยแพร่)

`.env` ที่ root ถูกแยกออกจากทั้ง Git และ build context ของ Docker ฐานข้อมูล ข้อมูลแอป และใบรับรองของ Caddy อยู่ใน named volume ของ Docker volume `webassets` เก็บ web asset ที่มี hash ของ build ล่าสุด (สูงสุด 20 ชุด แต่ละชุดเก็บหนึ่งสัปดาห์หลังถูกแทนที่) แท็บที่เปิดอยู่จึงยังโหลดได้หลังอัปเดต ไม่ต้องตั้งค่าอะไรและลบได้ทุกเมื่อ

ไฟล์ Compose สำหรับ production ตรึง Postgres และ Caddy ไว้กับ digest ของ manifest แบบ multi-architecture และ build ของ application/updater ที่เผยแพร่ก็ตรึง digest ของ base image ไว้ ให้อัปเดตการตรึงเหล่านี้อย่างตั้งใจเมื่อรับแพตช์ความปลอดภัยจาก upstream การเปลี่ยนเฉพาะ major tag ที่มองเห็นจะไม่เปลี่ยนเนื้อหาตราบที่ยังมี digest อยู่

## ที่อยู่ของไคลเอนต์

session, log และเหตุการณ์ความปลอดภัยมีที่อยู่ของผู้เรียกติดไปด้วย API จะเชื่อ header ที่ถูกส่งต่อมาเฉพาะเมื่อ TCP peer อยู่ใน `TRUSTED_PROXIES` (IP, ช่วง CIDR หรือชื่อโฮสต์ เช่นชื่อ service ใน Compose) โดยอ่าน header นั้น (`CLIENT_IP_HEADER` ค่าเริ่มต้น `x-forwarded-for`) จากขวาไปซ้ายผ่าน hop ที่เชื่อถือ กรณีอื่นใช้ TCP peer ไคลเอนต์จึงเลือกที่อยู่ของตัวเองไม่ได้ ถ้าไม่ตั้ง `TRUSTED_PROXIES` ใน container จะเป็น `local-networks` คือ loopback และทุกเครือข่ายที่ API มี interface อยู่ นอก container จะเป็น loopback เท่านั้น เพราะเครือข่ายของโฮสต์อาจมีไคลเอนต์ที่ต่อตรง `none` คือไม่เชื่อ proxy ใดเลย ใน Compose เครือข่ายเหล่านั้นคือเครือข่ายของ stack เอง ซึ่งมี container เว็บและ gateway ของเครือข่ายที่ reverse proxy บน Docker host ใช้เชื่อมต่อเข้ามา proxy บนโฮสต์ที่ตั้ง `X-Forwarded-For` (Caddy ตั้งให้ ส่วน nginx ต้องใช้ `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for`) จึงได้รับความเชื่อถือโดยไม่ต้องตั้งค่า computer ของ bot ไม่เคยอยู่บนเครือข่ายเหล่านั้น จึงเลือกที่อยู่เองไม่ได้ Compose สำหรับ production ตั้งเป็น `caddy` แทน สำหรับ layout อื่น ให้ระบุ proxy ทุกตัวระหว่างอินเทอร์เน็ตกับ API ขีดจำกัดอัตราการลงชื่อเข้าใช้นับต่อที่อยู่ของไคลเอนต์ proxy ที่ไม่ได้รับความเชื่อถือจะทำให้ผู้ใช้ทุกคนใช้ขีดจำกัดเดียวกัน

Caddy หาที่อยู่ของไคลเอนต์ก่อน `Caddyfile.prod` ใช้ TCP peer แล้วเขียนทับ `X-Forwarded-For` ด้วยค่านั้น ถ้าอยู่หลัง CDN Caddy ต้องเชื่อช่วง IP ของ CDN และอ่าน header ไคลเอนต์ของ CDN `Caddyfile.cloudflare.example` ทำแบบนี้ด้วยช่วง IP ของ Cloudflare และ `CF-Connecting-IP` สำหรับ CDN อื่น ให้คัดลอกไฟล์นั้นแล้วเปลี่ยนช่วง IP และ header ถ้าคุณคัดลอกตัวอย่าง Cloudflare ไว้ก่อนการเปลี่ยนแปลงนี้ ให้คัดลอกใหม่

## การแก้ไข firewall

การ hardening โฮสต์จะคงกฎ firewall เดิมไว้ และติดตั้ง `firewall-change.sh` เป็น `/usr/local/sbin/rakazo-firewall-change` การแก้ firewall ครั้งต่อไปให้ใช้ `sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change apply COMMAND...` ซึ่งต้องคง `SSH_CONNECTION` ไว้ จะบันทึกทั้ง `/etc/ufw` และ `/etc/default/ufw` และตั้ง rollback สามนาทีก่อนรันคำสั่ง เปิด **SSH connection ใหม่** แล้วรันคำสั่ง `confirm TOKEN` ที่พิมพ์ออกมา การยืนยันจาก connection เดิมจะถูกปฏิเสธ การเปลี่ยนแปลงที่ไม่ได้ยืนยันจะคืนกฎและ default policy ที่บันทึกไว้ ตัวป้องกันนี้ไม่คุ้มครองคำสั่ง `ufw` ที่รันตรง ๆ หรือการแก้ค่า SSH daemon

## Deploy จาก CI

ถ้าจะ deploy จาก CI ให้ติดตั้ง `infra/compose/deploy-launcher.sh` เป็น `/usr/local/sbin/rakazo-deploy-main` และให้ CI ใช้ key ที่จำกัดไว้กับคำสั่งนี้ใน `authorized_keys` ของผู้ใช้ deploy (`restrict,command="/usr/local/sbin/rakazo-deploy-main" ssh-ed25519 …`) CI จะ deploy commit บน main เฉพาะหลัง check ผ่านและ `ci.yml` เผยแพร่ image แล้ว โฮสต์จึงดึง `<RAKAZO_DEPLOY_IMAGE>:sha-<commit>` แทนการ build ข้าง traffic จริง `RAKAZO_DEPLOY_IMAGE` มีค่าเริ่มต้นเป็น `ghcr.io/<owner>/<repo>/app` ของ GitHub repository ที่ checkout ติดตามอยู่ fork จึงดึง image ที่ CI ของตัวเองเผยแพร่ ถ้าการดึงล้มเหลวหรือนานกว่า `RAKAZO_DEPLOY_PULL_TIMEOUT` (ค่าเริ่มต้น `5m`) การ deploy จะบันทึกคำเตือนแล้ว build checkout บนโฮสต์แทน ตั้ง `RAKAZO_DEPLOY_IMAGE=` (ว่าง) เพื่อ build ทุกครั้ง image ของ repository นี้เป็นสาธารณะ โฮสต์จึงไม่ต้องล็อกอิน registry สำหรับ package ของ fork ส่วนตัว ให้ `docker login ghcr.io` ในฐานะ root ด้วย token ที่อ่าน package ได้อย่างเดียว

การ deploy จะสตาร์ท container ใหม่ของ API, เว็บ และ worker ข้างตัวที่ทำงานอยู่ และหยุดตัวเก่าเมื่อตัวใหม่ healthy แล้วเท่านั้น การ deploy จึงไม่ทำให้เว็บล่มหรือแชทหยุดชะงัก จากนั้นรอ `https://$RAKAZO_HOST/health` และ rollback เมื่อล้มเหลวโดยคืน image ที่ container ก่อนหน้าใช้ worker เก่าไม่ถูกหยุด มันทำงานที่กำลังรันอยู่ให้เสร็จได้นานสูงสุด 45 นาที ขณะที่ตัวใหม่รับงานใหม่ และการ deploy จะรอมันก่อนจบ release ก่อนหน้ายังทำงานอยู่หลัง migration รัน migration จึงต้องใช้งานกับมันได้: เพิ่มก่อน แล้วค่อย drop หรือ rename ใน deploy ครั้งถัดไป การ pull, build และ start มีเวลาจำกัด ขั้นที่ค้างจึงทำให้ deploy ล้มเหลวแทนการถือ lock ไว้ deploy ที่พบว่า lock ถูกถืออยู่จะจบด้วยค่าไม่เป็นศูนย์ deploy จะไม่เริ่มถ้าพื้นที่ว่างน้อยกว่า `RAKAZO_DEPLOY_MIN_FREE_GB` (ค่าเริ่มต้น `5`) และหลัง rollout ที่ healthy จะเก็บ app image ปัจจุบันและก่อนหน้าไว้ (ตัวก่อนหน้าติด tag `rakazo-rollback`) ลบ image ที่ไม่มี tag และตัด build cache ที่ build สำรองทิ้งไว้ให้เหลือ `RAKAZO_DEPLOY_BUILD_CACHE_GB` (ค่าเริ่มต้น 8 GB)

สำหรับ checkout นอก `/srv/rakazo` ให้ใส่ `RAKAZO_DEPLOY_DIR=/absolute/path` (และค่าตั้งใดก็ได้ข้างต้น) ใน `/etc/rakazo/deploy.env` ที่ root เป็นเจ้าของและผู้ใช้ deploy อ่านได้ launcher รัน `infra/compose/deploy-main.sh` จาก `origin/main` การเปลี่ยนแปลงของ deploy จึงมีผลใน deploy ครั้งถัดไป มีเพียงการเปลี่ยนตัว launcher เองที่ต้องรัน `sudo install -m 0755 infra/compose/deploy-launcher.sh /usr/local/sbin/rakazo-deploy-main`

## Docker computer บน production stack

ใส่ `infra/compose/docker-compose.prod.docker.yml` ต่อจากไฟล์หลักในทุกคำสั่ง Compose เพื่อรัน computer ของ bot เป็น container Docker บนเครื่องแทน provider ระยะไกล:

```bash
# Pull only the pull-only dependency images (postgres, caddy, busybox);
# --pull never fails when they are absent locally.
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  pull --ignore-buildable
GIT_SHA="$(git rev-parse HEAD)" docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  up -d --build --wait --wait-timeout 300 --pull never
```

ในรูปแบบนี้ `api`, `worker`, `web`, `supervisor` และ `computer` build จาก checkout เสมอ `pull --ignore-buildable` ครอบคลุมเฉพาะ dependency ที่ไม่มีส่วน `build` ถ้าจะ deploy app image ที่เผยแพร่แล้วแทนการ build ให้ใช้ไฟล์หลักโดยไม่ใส่ overlay ถ้า `docker compose up --help` ไม่มี `--wait-timeout` (Compose รุ่นเก่า) ให้ตัด `--wait` ออกแล้วตรวจด้วย `docker compose ... ps` แทน เพราะ `--wait` อย่างเดียวอาจค้างกับ service แบบ one-shot

overlay จะเพิ่ม supervisor (app image, `user: root`, Docker socket), การ build image `computer` แบบ one-shot และการแก้ ownership ด้วย `data-init` ชี้ API และ worker ไปที่ `http://supervisor:7091` และตั้ง `SANDBOX_PROVIDER=docker` เป็นค่าเริ่มต้น ต้องมี `SANDBOX_SUPERVISOR_TOKEN` เฉพาะใน `.env` ส่วน `RAKAZO_COMPUTER_*` และขีดจำกัด `SANDBOX_*` ใช้ตามที่อธิบายใน `.env.example` supervisor มีสิทธิ์เทียบเท่า root บนโฮสต์เหมือน updater: ไม่ publish พอร์ต เข้าร่วมเฉพาะเครือข่ายภายใน `app` และ Caddy ไม่มี route ไปหามัน computer ของ bot เป็น container พี่น้องบนเครือข่ายแยกต่อ bot ที่มีเพียง supervisor และ screen proxy ของ `web` เข้าร่วม

เมื่อเปิด profile `updater` ด้วย ให้ sidecar ใช้รายการไฟล์และชุดที่ต้อง recreate เดียวกัน เพื่อไม่ให้การอัปเดตทิ้ง supervisor ไว้กับ app image เดิม:

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.prod.docker.yml
RAKAZO_UPDATE_SERVICES=supervisor
```

updater ดึงและ recreate service ได้ แต่ build image stub ของ `computer` ใหม่ไม่ได้ (`pull_policy: build` ดึงไม่ได้) ให้ build ใหม่บนโฮสต์เมื่อ image ของ computer ควรเปลี่ยน เช่นหลังอัปเดต checkout:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  build computer
```

## Layout การ deploy แบบอื่น

API และ worker ต้องเป็น process ที่ทำงานตลอดเวลา request handler แบบ serverless ไม่พอ ใช้ Node.js เวอร์ชันที่ `package.json` ที่ root รองรับ Postgres 16 ขึ้นไป และโดยค่าเริ่มต้นต้องมี volume `DATA_DIR` แบบถาวรที่ API และ worker ใช้ร่วมกัน พร้อม backup นอกโฮสต์ที่เข้ารหัส home ของ bot อยู่บน volume นั้น เว้นแต่เก็บไว้ใน [object storage](../self-host-storage.md#bot-homes-in-object-storage) เมื่อตั้ง object storage ไว้ตั้งแต่สตาร์ทครั้งแรก `DATA_DIR` จะเป็นแค่พื้นที่ชั่วคราวต่อ process แต่ละ replica จึงใช้ไดเรกทอรีที่ไม่ถาวรของตัวเองได้ ยกเว้นเมื่อรัน Docker computer: computer จะ mount home ที่ cache ไว้จาก `DATA_DIR/homes` API และ worker ที่สตาร์ท computer จึงต้องใช้ไดเรกทอรีนั้นร่วมกันบนโฮสต์เดียวกัน [ไดเรกทอรีข้อมูล](../self-host-storage.md#data-directory) แสดงว่าแต่ละ path เก็บอะไร

ใช้ HTTPS origin เดียวกันสำหรับเว็บแอป, `/api` และ `/rpc` คง route ของ screen proxy ที่ยืนยันตัวตนไว้ หลัง login gate แบบ cookie ให้ยกเว้นเฉพาะ `/novnc/session/*` ([เหตุผล](../self-host-kubernetes.md#add-a-login-gate-without-breaking-the-computer)) เลือก [computer provider](../self-host-sandbox-providers.md#choosing-a-provider) ที่เหมาะกับขอบเขตความไว้วางใจของบริการ `SIGNUPS_ENABLED` และ `SIGNUP_ALLOWLIST` มีผลจาก environment ทุกครั้งที่ API สตาร์ท เว็บไซต์การตลาดใน `apps/www` ที่ไม่บังคับโฮสต์แยกได้
