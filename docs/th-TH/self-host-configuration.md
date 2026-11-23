# การตั้งค่า

Rakazo อ่านจากตัวแปรสภาพแวดล้อม ปกติเก็บใน `.env` ข้างไฟล์ Compose แก้แล้ว restart บริการที่อ่านค่านั้น **อย่า commit `.env`**

## ที่อยู่การตั้งค่า

ดูรายการหลักใน `.env.example` (checkout) หรือ `.env.images.example` (published images)

ชื่อที่คุณตั้งเอง เช่น `TELEGRAM_BOT_TOKEN_<NAME>` ต้องใส่ในบล็อก `environment` ของ `api` และ `worker` ใน `docker-compose.override.yml` แล้วชี้ `-f docker-compose.override.yml` หลังไฟล์หลัก updater ต้องรวม override ใน `RAKAZO_COMPOSE_FILE` ด้วย

## ค่าหลักที่มักปรับ

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker
SANDBOX_IDLE_MS=600000
# Set 0 when self-hosting with Docker, where an idle computer costs nothing.
COMPUTER_MAX_ACTIVE_MS=7200000
```

`SANDBOX_IDLE_MS=0` ปิดการพักเมื่อ idle (ค่าปกติ 600000 คือ 10 นาที) `COMPUTER_MAX_ACTIVE_MS=0` ใช้เมื่อ self-host ด้วย Docker ที่ idle ไม่เสียค่า เพื่อไม่ตัดแอปและ session ที่รันนาน E2B, CreateOS และ Boat ยังมี timeout ของตัวเอง

ระยะหมดเวลาของโมเดล (จำนวนเต็ม หน่วยมิลลิวินาที):

- `MODEL_STREAM_TIMEOUT_MS`: 1000–2147483647 (ค่าเริ่มต้น 120000)
- `MODEL_STREAM_IDLE_TIMEOUT_MS`: 0–2147483647 (ค่าเริ่มต้น 180000); ตั้งเป็น `0` เพื่อปิดการตรวจจับสตรีมที่ไม่มีข้อมูล ซึ่งอาจทำให้คำขอที่ค้างรอไปเรื่อย ๆ จนกว่าผู้ให้บริการหรือผู้เรียกจะยุติคำขอ
- `MODEL_CONNECT_TIMEOUT_MS`: 1000–300000 (ค่าเริ่มต้น 30000)

ค่าที่ไม่ถูกต้องหรือเว้นว่างจะใช้ค่าเริ่มต้น

ฐานข้อมูลแยก login — owner สำหรับ migration (`DATABASE_MIGRATION_URL` / `POSTGRES_PASSWORD`) กับ `rakazo_app` (`DATABASE_URL` / `POSTGRES_APP_PASSWORD`) ถ้ามีแค่ `DATABASE_URL` อย่างเดียวจะมีคำเตือน RLS

`DB_POOL_MAX`, `REALTIME_DATABASE_URL`, `GRAPHILE_WORKER_CONCURRENCY` — ปรับ pool และ realtime

Proxy ออก: `HTTPS_PROXY`, `NO_PROXY=localhost,127.0.0.1,postgres,supervisor,api,worker,web`

ชื่อที่ตั้งเองและไม่มีในไฟล์ตัวอย่าง ใช้ได้เมื่อส่งเข้า `api` และ `worker` ผ่าน override ตามด้านบน
