# รายการตรวจ secret สำหรับ self-host

[English](../self-host-secrets.md) | ไทย

credential ที่จำเป็นและที่ไม่บังคับ สำหรับการ deploy ด้วย published images และ Compose

**อย่า commit `.env` อย่าวางค่า secret ใน issue/PR และอย่าเขียนทับ `.env` เดิมโดยไม่สำรองไว้ชัดเจนและได้รับความยินยอมจากผู้ดูแล**

## Published images: สิ่งที่ตัวติดตั้งเติมให้

`bash install-images.sh` (เมื่อยังไม่มี `.env`) จะคัดลอก `.env.images.example` แล้วเติมคีย์ที่ว่างด้วย `openssl`:

| Key                        | ค่าที่ตัวติดตั้งเติม           | หน้าที่                                                              |
| -------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | `openssl rand -hex 16` | รหัสผ่านเจ้าของ Postgres ภายใน Compose (ใช้กับ migration)              |
| `POSTGRES_APP_PASSWORD`    | `openssl rand -hex 16` | รหัสผ่านของ login `rakazo_app` ของแอป ซึ่ง row-level security มีผลกับมัน |
| `BETTER_AUTH_SECRET`       | `openssl rand -hex 32` | ลงนาม auth/session                                                |
| `ENCRYPTION_KEY`           | `openssl rand -hex 32` | เข้ารหัส credential ที่เก็บไว้                                          |
| `SCREEN_PROXY_SECRET`      | `openssl rand -hex 32` | ลงนาม capability ของหน้าจอ `/novnc/*` อายุสั้น                        |
| `SANDBOX_SUPERVISOR_TOKEN` | `openssl rand -hex 32` | การยืนยันตัวตนระหว่าง API ↔ sandbox supervisor                        |
| `RAKAZO_UPDATER_TOKEN`     | `openssl rand -hex 32` | credential เฉพาะของ updater ไม่ถูกใช้จนกว่าจะเปิด updater profile      |

การรันซ้ำจะ**เก็บ** `.env` เดิมไว้ (ไม่หมุน secret) จะเพิ่มเฉพาะ `POSTGRES_APP_PASSWORD` เมื่อ `.env` รุ่นเก่ายังไม่มี คีย์บังคับที่ว่างยังคงล้มเหลวแบบปิดไว้ก่อนตอน Compose validate (`${VAR:?Set … in .env}`)

สร้างเอง (รูปแบบเดียวกับที่ตัวติดตั้งใช้):

```bash
openssl rand -hex 16   # POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD
openssl rand -hex 32   # BETTER_AUTH_SECRET, ENCRYPTION_KEY, SCREEN_PROXY_SECRET, SANDBOX_SUPERVISOR_TOKEN
```

`.env.example` ของ source checkout ก็ต้องมี `POSTGRES_PASSWORD` และ `POSTGRES_APP_PASSWORD` (รูปแบบ `openssl rand -hex 16` เหมือนกัน) สำหรับ `infra/compose/docker-compose.yml` ให้ใส่ค่าเหล่านี้ใน `DATABASE_MIGRATION_URL` และ `DATABASE_URL` ฝั่งโฮสต์เมื่อใช้ overlay `docker-compose.postgres-host.yml` ที่ไม่บังคับ รหัสผ่านต้องปลอดภัยใน URI เพราะ Compose แทนค่าลงใน `DATABASE_URL` แบบเดียวกับ stack ของ images ค่า hex จาก `openssl rand` ปลอดภัย แต่อักขระอย่าง `@ : / ? # %` ไม่ปลอดภัย

volume `pgdata` ของ source checkout ที่มีอยู่จะคง user, password และ database จากการ init ครั้งแรก (มักเป็นค่า hardcode เดิม `rakazo` / `rakazo`) เก็บค่าเหล่านั้นไว้ใน `.env` หรือเปลี่ยนในที่ด้วย `ALTER ROLE` / rename สร้าง volume ใหม่เฉพาะหลังสำรองข้อมูลแล้ว (หรือเมื่อข้อมูลทิ้งได้) `docker compose down -v` จะลบ state ของ Postgres ทั้งหมด

`.env.example` ของ source checkout ระบุในคอมเมนต์ให้ใช้ `ENCRYPTION_KEY` แบบ **64 hex** ส่วนตัวติดตั้ง published images ใช้ hex 32 ไบต์ (64 ตัวอักษร hex) ผ่าน `openssl rand -hex 32` ไม่ว่าแบบไหน ควรใช้ค่าสุ่มยาวที่ไม่ขึ้นต่อกัน อย่าใช้สตริงเดียวกันกับหลายคีย์

## กฎการไม่ใช้ค่าซ้ำ

ค่าต่อไปนี้ต้องเป็นค่าสุ่มที่**แยกกัน** (อย่าคัดลอก secret เดียวกันไปใส่หลายคีย์):

- `BETTER_AUTH_SECRET`
- `ENCRYPTION_KEY`
- `SCREEN_PROXY_SECRET`
- `SANDBOX_SUPERVISOR_TOKEN`
- `RAKAZO_UPDATER_TOKEN` (เฉพาะเมื่อเปิด updater profile ยาวอย่างน้อย 32 ตัวอักษร และต้องไม่ซ้ำกับสี่คีย์ข้างบน)

การหมุน `ENCRYPTION_KEY` หลังเก็บ credential ไปแล้วจะทำให้ ciphertext เดิมอ่านไม่ได้ สำหรับ deployment ที่มีอยู่ ให้เก็บคีย์เดิมไว้ เว้นแต่ตั้งใจล้างข้อมูลที่เข้ารหัสทิ้ง

`ENCRYPTION_KEY` ยังใช้สร้าง master key เริ่มต้นสำหรับการเข้ารหัสแชท memory และไฟล์ด้วย การเปลี่ยนคีย์จึงทำให้เนื้อหาเหล่านั้นอ่านไม่ได้เช่นกัน ถ้าจะย้ายเนื้อหาออกจากคีย์นี้ ให้ตั้ง `ENCRYPTION_MASTER_KEYS` แล้วทำการหมุนตาม [content-encryption.md](../content-encryption.md) ซึ่งจะห่อคีย์ของ Space ใหม่โดยไม่ทิ้งเนื้อหาไว้กลางทาง หลังจากนั้นให้คง `ENCRYPTION_KEY` ไว้เหมือนเดิม เพราะ credential ที่เก็บไว้ยังขึ้นกับมัน

เมื่อใช้ `MASTER_KEY_PROVIDER=aws-kms` secret เหล่านี้และ secret อื่นของ API และ worker เก็บใน `.env` แบบห่อด้วย key manager แทน plaintext ได้ ([wrapped settings](../content-encryption.md#wrapped-settings))

## คีย์ที่ไม่บังคับ (เว้นว่างถ้าไม่ใช้)

จาก `.env.images.example` (ตัวติดตั้ง images) เว้นว่างได้ถ้าไม่ใช้:

| Key(s)                                                         | ใช้เมื่อ                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                                           | โมเดล OpenRouter สำหรับทั้ง deployment                                                                   |
| `TYPESAFE_API_KEY`                                             | ตัวตรวจ TypeSafe Jev Auto Review ที่ไม่บังคับ (`RAKAZO_AUTO_REVIEW_PROVIDER=jev`)                           |
| `COMPOSIO_API_KEY`                                             | แคตตาล็อกที่ Composio จัดการ                                                                              |
| `E2B_API_KEY` / `DAYTONA_API_KEY` / `BOAT_API_KEY`             | computer ระยะไกลเมื่อ `SANDBOX_PROVIDER` ไม่ใช่ `docker`                                                  |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `SMTP_URL` / `EMAIL_FROM` | อีเมลบัญชีผ่าน Resend API หรือ SMTP ที่ไม่บังคับ                                                                |
| `BOT_EMAIL_SMTP_URL`                                           | การเชื่อมต่อ SMTP แบบ TLS แยกสำหรับการส่งเมลของ bot ดู [อีเมลของ bot](../self-host-inbound-email.md#sending) |
| `EXPO_ACCESS_TOKEN`                                            | push บนมือถือเมื่อโปรเจกต์ Expo เปิด enhanced push security                                                 |
| token ของแอปแชท (Slack, Telegram, …)                           | เฉพาะเมื่อเปิดช่องทางเหล่านั้น                                                                               |

`APNS_VOIP_KEY_ID`, `APNS_VOIP_TEAM_ID` และ `APNS_VOIP_PRIVATE_KEY` ที่ไม่บังคับ จะเปิด [การเรียกเข้าแบบ VoIP บน iOS](../self-host-clients.md#mobile-incoming-calls) เก็บเนื้อหาไฟล์ `.p8` ไว้ใน secret manager

คีย์ไม่บังคับที่ว่างเป็นเรื่องปกติสำหรับการบูต published images แบบขั้นต่ำ คีย์ Pipedream Connect มีเฉพาะใน `.env.example` ของ source/Compose ไม่มีในตัวอย่างของ images

## ขั้นตอนของผู้ดูแล

```bash
bash install-images.sh --prepare-only   # creates .env + fills empties
# inspect key NAMES only if debugging; never log values
bash install-images.sh                  # pull + up; preserves .env
curl -fsS http://127.0.0.1:3100/internal/health
```

ถ้า `sandbox` ใน `/internal/health` เป็น `"none"` หรือ supervisor ไม่เคย healthy ให้ตรวจว่าตั้ง `SANDBOX_SUPERVISOR_TOKEN` ไว้และไม่ว่างสำหรับเส้นทาง Docker computer token ที่หายไปคือการตั้งค่าที่ล้มเหลว ไม่ใช่สิ่งที่ "ค่อยเข้มงวดทีหลังก็ได้"

## กู้คืนโดยไม่พิมพ์ secret ออกมาอีก

- ลืมรหัสผ่าน UI: ใช้การกู้คืนผ่าน SMTP ถ้าตั้งไว้ ไม่เช่นนั้นการกู้ตัวตนของผู้ดูแลต้องทำนอกระบบ (ที่ DB) ไม่ควรหมุน `BETTER_AUTH_SECRET` บน deploy ที่ใช้งานอยู่โดยไม่จำเป็น
- `.env` หาย: กู้จาก backup เท่านั้น การสร้าง secret สุ่มใหม่บน volume ที่ยังมีข้อมูล Postgres จะทำให้รหัสผ่านและการเข้ารหัสไม่ตรงกัน
- ย้ายโฮสต์: คัดลอก `.env` และ volume ไปพร้อมกัน ถือว่า `.env` เป็นข้อมูลลับระหว่างการขนย้าย

## ที่เกี่ยวข้อง

- [Self-host](./self-host.md)
- [การตั้งค่า](./self-host-configuration.md)
- [Storage และการเข้ารหัส](../self-host-storage.md)

## การเก็บ credential แบบทางเลือก

credential ที่เก็บไว้ใช้ Infisical แบบ self-host ได้ ขณะที่ secret อายุสั้นยังเข้ารหัสอยู่ใน Postgres ดู [การตั้งค่า Infisical การย้าย และการย้อนกลับ](../infisical-secrets.md)
