# บัญชีและการลงชื่อเข้าใช้

กำหนดว่าใครสมัครได้ และวิธีลงชื่อเข้าใช้

## ใครสมัครได้

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
```

allowlist ที่ว่างจะล้างรายการเก่า สมัครคนแรกไม่ได้สิทธิ์ admin เซิร์ฟเวอร์ ไม่มีบทบาท app-admin

บัญชีแอปเปลี่ยนนโยบายสมัครหรือ secret การ deploy ไม่ได้

## การติดตั้งที่ไม่มีอีเมล

ตั้ง `SIGNUPS_ENABLED=false` แล้ว bootstrap บัญชีแรก:

```bash
read -r -p "Account email: " OWNER_EMAIL
read -r -s -p "Account password (at least 16 characters): " OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
docker compose --env-file .env -f docker-compose.images.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
unset OWNER_EMAIL OWNER_PASSWORD
```

จาก checkout ใช้ `-f infra/compose/docker-compose.yml` แทน การติดตั้งที่ไม่มีอีเมลควรอยู่บนเครือข่ายที่เชื่อถือได้

มี allowlist และ SMTP แล้วต้องยืนยันอีเมลก่อนลงชื่อเข้าใช้ ถ้าส่งอีเมลไม่ได้ ให้ใช้ bootstrap ด้านบน

## นโยบายรหัสผ่าน

รหัสใหม่ 8–128 ตัวอักษร ไม่บังคับความซับซ้อน

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

ตรวจ Have I Been Pwned (ส่งแค่ 5 ตัวแรกของ hash) ปิดตามค่าเริ่มต้น

## SSO (OpenID Connect)

ตั้ง `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` บน API พร้อมกัน redirect ที่ provider:

```text
https://app.example.com/api/auth/callback/oidc
```

`AUTH_PASSWORD_ENABLED=false` = SSO เท่านั้น ต้องตั้ง OIDC ครบก่อน API จะสตาร์ท

`OIDC_ALLOW_SIGNUP_BYPASS=true` ข้าม allowlist เฉพาะเมื่อคุณไว้ใจ IdP ควบคุมการเข้าร่วม

## SCIM (ทางเลือก)

IdP สร้างหรือปิดการใช้งานบัญชีผ่าน SCIM 2.0 การปิดบัญชีไม่ลบข้อมูล สร้างโทเค็นด้วย `openssl rand -hex 32` แล้วตั้งบน API:

```env
SCIM_BEARER_TOKEN=
```

ใช้กับ provisioning ไดเรกทอรี ไม่ต้องตั้งถ้าไม่มี IdP ที่รองรับ

## อีเมล transactional

Resend:

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=replace-with-sending-api-key
EMAIL_FROM=Rakazo <hello@mail.example.com>
```

SMTP: `SMTP_URL=smtps://...` และ `EMAIL_FROM` development ใช้ `EMAIL_EMULATOR=true` ได้ (ปิดบน production)

## Passkeys

เปิดเมื่อ `WEB_ORIGIN` เป็นโดเมน HTTPS หรือ `localhost` ตอนพัฒนา passkey เดิมใช้ได้เฉพาะโดเมนเดิม ปิดเมื่อเป็น SSO อย่างเดียว

แอปที่ build เองใช้ passkey ของโดเมนนี้ได้เมื่อตั้งค่าด้านล่าง ยังไม่ตั้งแพลตฟอร์มไหน แอปนั้นจะซ่อน passkey แอป macOS ที่ปล่อยทั่วไปผูกกับ `app.rakazo.com` จึงซ่อน passkey ของเซิร์ฟเวอร์อื่น

```bash
PASSKEY_APPLE_APP_IDS=ABCDE12345.com.rakazo.app,ABCDE12345.dev.rakazo.desktop
PASSKEY_ANDROID_CERT_SHA256=AA:BB:...:FF
```

reverse proxy ต้องส่ง `/.well-known/` ต่อไปที่เว็บ ถ้า build เอง ให้ `RAKAZO_PASSKEY_RP_ID` ตรงกับโดเมน บนเครือข่ายส่วนตัวตั้ง `RAKAZO_PASSKEY_DEVELOPER_MODE=1`
