# Production

รัน Rakazo บนเซิร์ฟเวอร์สาธารณะ พร้อม HTTPS และฮาร์ดนิงโฮสต์

## VM เดียว + Caddy

`infra/compose/docker-compose.prod.yml` รัน Postgres, API, worker, web และ HTTPS อัตโนมัติผ่าน Caddy production ค่าเริ่มต้นใช้คอมพิวเตอร์ remote (เช่น E2B) ไม่เปิด Docker supervisor บนสาธารณะ

ก่อน deploy ครั้งแรก: สร้างบัญชี `deploy` แบบ key-only แล้วรัน hardening

```bash
sudo --preserve-env=SSH_CONNECTION DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

เปิด SSH console ไว้จนล็อกอิน SSH ใหม่สำเร็จหลังรีโหลด SSH

1. ตั้ง DNS `A`/`AAAA` ชี้ VM เปิด TCP 80/443 (และ UDP 443 ถ้าต้องการ)
2. clone repo สร้าง `.env` อย่างน้อย: `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `OPENROUTER_API_KEY`, key ของ `SANDBOX_PROVIDER`, `RAKAZO_HOST`, `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL` เหมือน HTTPS origin **อย่าเผยแพร่ Postgres**
3. จำกัดการสมัครขณะที่บริการยังไม่เปิดสาธารณะ:

```env
NODE_ENV=production
RAKAZO_HOST=app.example.com
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com
SANDBOX_PROVIDER=e2b
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
```

4. build และสตาร์ท:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

ครั้งแรกต้อง **build** เพราะ `RAKAZO_IMAGE_TAG=local` ไม่มีบน registry

ไฟร์วอลล์ของเครื่อง (UFW) หลัง hardening อนุญาตแค่ SSH/HTTP/HTTPS อย่าล็อกตัวเองออกจาก VM ถ้าไม่มีคอนโซลของผู้ให้บริการ

แก้ firewall หลัง hardening ด้วย `sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change apply COMMAND...` มี rollback 3 นาที ต้องยืนยันจาก SSH connection ใหม่ คำสั่ง `ufw` โดยตรงไม่มีการป้องกันนี้

ที่อยู่ของไคลเอนต์: API เชื่อ header ที่ส่งต่อเฉพาะเมื่อ TCP peer อยู่ใน `TRUSTED_PROXIES` ถ้า proxy ไม่ถูกเชื่อ ทุกคนจะติด rate limit เดียวกัน Production Compose ตั้ง `caddy` ไว้แล้ว layout อื่นต้องระบุ proxy ทุกตัวระหว่างอินเทอร์เน็ตกับ API

รายละเอียดอัปเกรด แบ็กอัป และ updater: [อัปเกรด](./self-host-upgrading.md), [สำรอง](./self-host-backups.md)
