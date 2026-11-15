# Secrets สำหรับ self-host

**อย่า commit `.env` อย่าโพสต์ค่า secret ใน issue/PR และอย่าเขียนทับ `.env` เดิมโดยไม่สำรองและได้รับความยินยอม**

## สิ่งที่ installer เติม (published images)

`bash install-images.sh` (เมื่อยังไม่มี `.env`) คัดลอก `.env.images.example` แล้วเติมคีย์ว่างด้วย `openssl`:

| Key                        | การเติม                 |
| -------------------------- | ---------------------- |
| `POSTGRES_PASSWORD`        | `openssl rand -hex 16` |
| `POSTGRES_APP_PASSWORD`    | `openssl rand -hex 16` |
| `BETTER_AUTH_SECRET`       | `openssl rand -hex 32` |
| `ENCRYPTION_KEY`           | `openssl rand -hex 32` |
| `SCREEN_PROXY_SECRET`      | `openssl rand -hex 32` |
| `SANDBOX_SUPERVISOR_TOKEN` | `openssl rand -hex 32` |

รันซ้ำ **เก็บ** `.env` เดิม ไม่หมุน secret คีย์บังคับว่างจะ fail ตอน validate Compose

สร้างมือ:

```bash
openssl rand -hex 16   # POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD
openssl rand -hex 32   # BETTER_AUTH_SECRET, ENCRYPTION_KEY, SCREEN_PROXY_SECRET, SANDBOX_SUPERVISOR_TOKEN
```

## ต้องไม่ซ้ำกัน

`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `SANDBOX_SUPERVISOR_TOKEN` (และ `RAKAZO_UPDATER_TOKEN` ถ้าเปิด updater) ต้องเป็นค่าสุ่ม**คนละค่า**

หมุน `ENCRYPTION_KEY` หลังมี credential เก็บไว้จะถอดรหัสไม่ได้

`docker compose down -v` ลบ state Postgres ทั้งหมด — สำรองก่อนถ้า volume มีข้อมูล

## คีย์ทางเลือก

เช่น `OPENROUTER_API_KEY`, `COMPOSIO_API_KEY`, `E2B_API_KEY` / `DAYTONA_API_KEY` / `BOAT_API_KEY` ตาม `SANDBOX_PROVIDER` ปล่อยว่างได้ถ้าไม่ใช้

## ขั้นตอนผู้ดูแล

```bash
bash install-images.sh --prepare-only
bash install-images.sh
curl -fsS http://127.0.0.1:3100/internal/health
```

ถ้า sandbox ใน health เป็น `"none"` ตรวจ `SANDBOX_SUPERVISOR_TOKEN` ว่าตั้งและไม่ว่าง

## กู้คืนโดยไม่พิมพ์ secret ซ้ำ

- ลืมรหัส UI: ใช้ SMTP recovery ถ้ามี ไม่งั้นต้องแก้ที่ DB อย่าหมุน `BETTER_AUTH_SECRET` บน production โดยไม่จำเป็น
- หาย `.env`: ใช้จาก backup เท่านั้น สร้าง secret ใหม่กับ volume เดิมจะทำให้รหัส DB และการเข้ารหัสไม่ตรงกัน
- ย้ายเครื่อง: คัดลอก `.env` กับ volume พร้อมกัน

ดูเพิ่ม: [self-host](./self-host.md), [การตั้งค่า](./self-host-configuration.md)
