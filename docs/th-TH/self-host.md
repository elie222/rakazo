# Self-host Rakazo

รัน API, worker, เว็บ, ฐานข้อมูล และ computer ของ bot บนเครื่องที่คุณควบคุม

## สิ่งที่ต้องมี

- Docker Engine 26 ขึ้นไป พร้อม Compose plugin, curl และ OpenSSL (สำหรับ published images)
- โมเดล: คีย์ OpenRouter, เชื่อมต่อในแอปหลังสมัคร หรือเซิร์ฟเวอร์โมเดลของคุณ — ดู [โมเดล](./self-host-models.md)
- เครื่องสาธารณะ: โดเมนและ TLS — ดู [production](./self-host-production.md)

## Published images (ไม่ต้อง checkout)

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

ตัวติดตั้งจะสร้าง `.env` ดึง image แล้วสตาร์ท การรันซ้ำจะเก็บ `.env` เดิม ถ้าจะปรับก่อนสตาร์ท ให้ใช้ `bash install-images.sh --prepare-only` แก้ `.env` แล้วรันอีกครั้ง

`SANDBOX_PROVIDER` ค่าเริ่มต้น `docker` เปลี่ยนเป็น `e2b`, `novita`, `daytona`, `createos`, หรือ `boat` ต้องใส่ API key ที่ตรงกัน ทุก provider ต้องมี `SANDBOX_SUPERVISOR_TOKEN` ไม่งั้น `compose up` จะ fail

เปิด [http://127.0.0.1:5173](http://127.0.0.1:5173) สมัครแล้วไม่ได้สิทธิ์ admin เซิร์ฟเวอร์

เครื่องสาธารณะ: ใส่ TLS หน้า `:5173` ตั้ง `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL` เป็น HTTPS เดียวกัน และ `RAKAZO_HOST` เป็นชื่อโฮสต์ อย่าเปิด port API `3100` ออกสู่ภายนอก

**อย่าเผยแพร่ Postgres บน interface สาธารณะ**

## Docker Compose (เครื่องเดียว)

คัดลอก `.env.example` เป็น `.env` ตั้ง `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` (แต่ละอัน `openssl rand -hex 16`), `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `SANDBOX_SUPERVISOR_TOKEN` เป็นค่าสุ่มแยกกัน

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

Postgres อยู่ในเครือข่าย Compose เท่านั้น การลบ volume ทำด้วย `docker compose down -v` จะลบ state Postgres ทั้งหมด

## Source checkout

`.env` จาก `.env.example`, `pnpm sandbox:build`, `pnpm dev` แล้วเปิด URL ที่พิมพ์ออกมา (ปกติ [http://127.0.0.1:5173](http://127.0.0.1:5173))

## ตั้งค่าและดูแล (ภาษาไทย)

- [การตั้งค่า](./self-host-configuration.md)
- [Secrets](./self-host-secrets.md)
- [บัญชี](./self-host-accounts.md)
- [โมเดล](./self-host-models.md)
- [Production](./self-host-production.md)
- [สำรองและกู้คืน](./self-host-backups.md)
- [อัปเกรด](./self-host-upgrading.md)
- [แก้ปัญหา](./troubleshooting.md)

## รายงานปัญหา

แนบ diagnostics (ไม่มี secret):

```bash
docker compose -f docker-compose.images.yml exec api node dist/cli/diagnostics.js
```

จาก checkout ใช้ `-f infra/compose/docker-compose.yml` แทน
