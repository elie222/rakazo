# การลงชื่อเข้าใช้และบัญชี

[English](../self-host-accounts.md) | ไทย

กำหนดว่าใครสร้างบัญชีได้และลงชื่อเข้าใช้อย่างไร: allowlist, การยืนยันอีเมล, SSO, passkey และกฎรหัสผ่าน

## ใครสมัครได้

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
```

`SIGNUPS_ENABLED` และ `SIGNUP_ALLOWLIST` อ่านจาก environment ของผู้ดูแลทุกครั้งที่สตาร์ท allowlist ที่ว่างจะล้างรายการเก่าที่เก็บไว้ ลำดับการสมัครไม่เคยให้สิทธิ์พิเศษ

การตั้งค่าเซิร์ฟเวอร์อยู่ใน environment ของผู้ดูแล บัญชีในแอปเปลี่ยนนโยบายการสมัคร credential การเชื่อมต่อของเซิร์ฟเวอร์ หรือการอัปเดต deployment ไม่ได้ และอ่าน log ความปลอดภัยของ deployment ไม่ได้

ไม่มีบทบาท app-admin ไม่มีสิทธิ์ของผู้ใช้คนแรก และไม่มีรายการ `ADMINS` เจ้าของ workspace จัดการได้เฉพาะ workspace ของตัวเอง

`RAKAZO_ADMIN_EMAILS` ระบุบัญชี (คั่นด้วยจุลภาค) ที่ตรวจ plugin ที่ส่งเข้ามา เพิ่ม MCP server แบบ stdio ([การเชื่อมต่อ](../self-host-integrations.md)) เลือกโมเดลให้ทุกคน ([โมเดล](./self-host-models.md#ค่าเริ่มต้นสำหรับทุกคน)) และบน deployment ที่ขายเครดิตโมเดล ให้สิทธิ์ใช้ฟรีที่ `/admin/access` บัญชีจะนับเมื่อยืนยันอีเมลแล้วเท่านั้น และไม่ได้สิทธิ์อื่นใดเพิ่ม

สิทธิ์ใช้ฟรีระบุอีเมลหนึ่งรายการ และให้เครดิตโมเดลได้สูงสุด $1,000, ใช้คีย์ของตัวเองฟรีได้สูงสุด 12 เดือน หรือทั้งสองอย่าง ผู้ที่เป็นเจ้าขององค์กรที่มีอีเมลนั้นและยืนยันแล้วจะได้รับในครั้งถัดไปที่เปิดแอป ไม่ว่าจะสมัครก่อนหรือหลังการให้สิทธิ์ เพิกถอนสิทธิ์ได้จนกว่าจะมีคนรับไป

## ตั้งค่าทีม

ทีมใช้องค์กรร่วมกันหนึ่งองค์กร ทุกคนในองค์กรได้ Space ส่วนตัวของตัวเอง และแชร์ Space ที่ตัวเองเลือก

1. **ให้เพื่อนร่วมทีมสมัครได้** คำเชิญไม่ข้ามนโยบายการสมัคร คง `SIGNUPS_ENABLED=true` ไว้ และใส่ที่อยู่อีเมลหรือโดเมนของทีมใน `SIGNUP_ALLOWLIST` หรือ provision ผ่าน [SSO](#sso-ด้วย-openid-connect) หรือ [SCIM](#directory-provisioning-scim)
2. **ให้ทุกคนมีโมเดล** เพื่อนร่วมทีมที่ไม่มีโมเดลของตัวเองจะใช้ [โมเดลของ deployment](./self-host-models.md#โมเดลของ-deployment) ซึ่งคิดค่าใช้จ่ายกับคีย์ของผู้ดูแล แต่ละคนยังเชื่อมต่อโมเดลของตัวเองได้
3. **เชิญเข้าองค์กร** ใน **Settings → Organization → Members** ใส่อีเมลแล้วเลือก **Invite** ผู้ได้รับเชิญลงชื่อเข้าใช้ด้วยที่อยู่นั้นแล้วเลือก **Join** ถ้าไม่มี [อีเมล](#อีเมลยืนยันและกู้คืนรหัสผ่าน) จะไม่มีอะไรถูกส่ง ให้เลือก **Copy invite link** ที่คำเชิญที่รออยู่แล้วส่งเอง คำเชิญหมดอายุหลัง 7 วัน
4. **แชร์ Space** ใน **Settings** ของ Space ปุ่ม **Invite** จะแสดงสมาชิกขององค์กรให้เพิ่มได้ทันที ดู [Share a space](../spaces.md#share-a-space)

เจ้าของและ admin เชิญคน เปลี่ยนบทบาท และลบสมาชิกได้ เจ้าของถูกลบไม่ได้ Space ของสมาชิกที่ถูกลบซึ่งไม่มีใครใช้จะตกเป็นของผู้ที่ลบสมาชิกนั้น การจัดการสมาชิกทำบนเว็บและเดสก์ท็อป

SSO และ SCIM สร้างบัญชีแต่ไม่เพิ่มใครเข้าองค์กร ให้เชิญหลังจากเขาลงชื่อเข้าใช้ครั้งแรก admin ขององค์กรไม่เกี่ยวกับ `RAKAZO_ADMIN_EMAILS` และเซิร์ฟเวอร์แบบ self-host ไม่มี seat หรือ billing เว้นแต่คุณ [ตั้งค่าไว้](../self-host-billing.md)

## การยืนยันอีเมลและรหัสลงชื่อเข้าใช้

เมื่อมี signup allowlist ที่ไม่ว่างและตั้ง SMTP แล้ว ผู้ใช้ทุกคน รวมถึงบัญชีที่มีอยู่ ต้องยืนยันอีเมลก่อนลงชื่อเข้าใช้ ถ้าไม่มี allowlist การยืนยันจะไม่บล็อก: การสมัครด้วยรหัสผ่านลงชื่อเข้าใช้ได้ทันที และได้รับลิงก์ยืนยันที่ทำเพียงทำเครื่องหมายว่าที่อยู่ยืนยันแล้ว

SMTP ยังเปิดการลงชื่อเข้าใช้ด้วยรหัสหกหลักทางอีเมล ซึ่งหมดอายุในสิบนาทีและลองได้สามครั้ง รหัสสร้างบัญชีได้ จึงใช้กฎการลงทะเบียนและ allowlist เดียวกับการสมัครด้วยรหัสผ่าน การลงชื่อเข้าใช้ด้วยรหัสในบัญชีเดิมที่ยังไม่ยืนยันจะลบรหัสผ่าน ลิงก์ SSO และ session ของบัญชีนั้น เพราะไม่มีอะไรพิสูจน์ว่าสิ่งเหล่านั้นเป็นของเจ้าของกล่องเมล วิธีนี้กันไม่ให้คนที่ลงทะเบียนด้วยที่อยู่ของคนอื่นเข้าถึงต่อได้ การรีเซ็ตรหัสผ่านพิสูจน์กล่องเมลแบบเดียวกัน การรีเซ็ตรหัสผ่านของบัญชีที่ยังไม่ยืนยันจึงลบลิงก์ SSO, passkey และอุปกรณ์ที่จับคู่ไว้ด้วย

การสมัครแบบ allowlist ต้องยืนยันกล่องเมลและส่งอีเมลได้ รวมถึงบัญชีแรก ถ้าส่งอีเมลไม่ได้ ให้ใช้การ bootstrap บัญชีฝั่งเซิร์ฟเวอร์ที่อธิบายด้านล่าง การสมัครสาธารณะไม่เคยทำเครื่องหมายว่าที่อยู่ยืนยันแล้วหรือให้สิทธิ์เซิร์ฟเวอร์

## การติดตั้งที่ไม่มีอีเมล

สำหรับการติดตั้งที่ไม่มีอีเมล ให้ตั้ง `SIGNUPS_ENABLED=false` ใน `.env` ก่อนแล้วสตาร์ท stack จากนั้นสร้างบัญชีที่ต้องการแบบส่วนตัว (รหัสผ่านอยู่ใน environment ของ shell):

```bash
read -r -p "Account email: " OWNER_EMAIL
read -r -s -p "Account password (at least 16 characters): " OWNER_PASSWORD
export OWNER_EMAIL OWNER_PASSWORD
docker compose --env-file .env -f docker-compose.images.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js
unset OWNER_EMAIL OWNER_PASSWORD
```

สำหรับ source checkout ให้ใช้ `-f infra/compose/docker-compose.yml` แทน คำสั่งนี้สร้างบัญชีธรรมดาที่ยืนยันแล้วพร้อม workspace ส่วนตัว โดยไม่มีสิทธิ์เซิร์ฟเวอร์ สำหรับบัญชีเดิมที่ยังไม่ยืนยัน รหัสผ่านต้องตรงกันก่อนจึงจะยืนยันได้ บัญชีเดิมที่ยืนยันแล้วจะไม่ถูกเปลี่ยน
การติดตั้งที่ไม่มีอีเมลควรอยู่บนเครือข่าย local ที่เชื่อถือได้

## อีเมลยืนยันและกู้คืนรหัสผ่าน

การเปลี่ยนรหัสผ่านของผู้ใช้ที่ลงชื่อเข้าใช้อยู่ไม่ต้องตั้งค่าอีเมล การกู้คืนรหัสผ่านที่ลืมจะแสดงในหน้าลงชื่อเข้าใช้เฉพาะเมื่อมี provider อีเมล transactional Rakazo ใช้ข้อกำหนดกลางที่ไม่ผูกกับ provider พร้อม adapter สำหรับ Resend API และ SMTP template render บนเครื่องด้วย React Email เป็น HTML และข้อความล้วน โดยไม่ขึ้นกับ provider ที่ใช้ส่ง

ถ้าจะใช้ Resend HTTP API ให้ยืนยันโดเมนสำหรับส่ง และสร้าง API key แบบส่งอย่างเดียวที่จำกัดไว้กับโดเมนนั้น แล้วตั้งค่า:

```env
EMAIL_PROVIDER=resend
EMAIL_API_KEY=replace-with-sending-api-key
EMAIL_FROM=Rakazo <hello@mail.example.com>
```

ปิดการติดตามการคลิกและการเปิดสำหรับอีเมลบัญชีในการตั้งค่าโดเมนของ provider การส่งผ่าน Resend มีกำหนดเวลาสิบวินาทีและลองซ้ำแบบจำกัดจำนวนด้วย idempotency key เดิม รวมถึงเมื่อ response หายไป ข้อผิดพลาดจะไม่รวม body ของ response จาก provider และ credential

สำหรับ Amazon SES หรือเซิร์ฟเวอร์ SMTP อื่น ให้ใช้:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Rakazo <no-reply@example.com>
```

ตั้ง `EMAIL_REPLY_TO` เพื่อให้การตอบกลับไปที่อื่นที่ไม่ใช่ `EMAIL_FROM`

`EMAIL_PROVIDER=smtp` ไม่บังคับ: `SMTP_URL` ที่มีอยู่ยังเลือก SMTP เมื่อไม่ระบุ provider `EMAIL_PROVIDER=none` ปิดการส่งออกภายนอก การตั้งค่า provider ที่ระบุชัดเจนมีลำดับเหนือ `SMTP_URL` เก่า การตั้งค่า provider ที่ไม่ครบหรือไม่รู้จักจะล้มเหลวตอนสตาร์ท

Resend รองรับ SMTP ด้วย: ใช้ `smtp.resend.com` ชื่อผู้ใช้ `resend` และ API key เป็นรหัสผ่าน สำหรับ Amazon SES ให้ใช้ SMTP endpoint ของภูมิภาคและ SMTP credential ของ SES ซึ่งต่างจาก access key ปกติของ AWS ยืนยันผู้ส่ง/โดเมนกับ provider ก่อนทดสอบการส่ง เก็บ credential ใน `.env` ห้ามอยู่ในไฟล์ที่ track `smtps://` ใช้ implicit TLS ส่วน `smtp://` ก็รองรับแต่ต้องใช้ STARTTLS Rakazo ปฏิเสธการตั้งค่าที่ปิด TLS หรือการตรวจใบรับรอง

การพัฒนาจาก source บนเครื่องใช้ตัวจำลองอีเมลแบบออฟไลน์แทนได้ มันเก็บอีเมลไว้โดยไม่ติดต่อ provider:

```env
EMAIL_EMULATOR=true
```

ตัวจำลองถูกบังคับปิดเมื่อ `NODE_ENV=production` และต้องให้ API bind กับโฮสต์ loopback ใน `NODE_ENV=development` ข้อความที่เก็บไว้ดูได้จาก `http://127.0.0.1:3100/api/dev/emails` โดยปิด cache ไว้ API บันทึกเฉพาะ metadata ของการส่ง ไม่บันทึก reset token route กล่องเมลนี้ไม่ถูกลงทะเบียนใน test, staging หรือ production

Rakazo ยังส่งอีเมลของผลิตภัณฑ์ได้ แต่ละฉบับมีลิงก์ยกเลิกการรับ: อีเมลต้อนรับหลังบัญชีใหม่ลงชื่อเข้าใช้ครั้งแรก อีเมลแนะนำเพื่อนเมื่อเปิด referral ของ billing และเมื่อตั้ง billing ไว้ จะมีอีเมลเตือนหลังแพ็กเกจเริ่ม (เชื่อมต่อโมเดล นำเข้า agent) repository นี้ไม่มีข้อความของอีเมลเหล่านี้ แต่ละฉบับจะส่งออกเฉพาะเมื่อคุณใส่ข้อความเอง และเฉพาะกับ provider ข้างบนเท่านั้น

ข้อความเป็นโฟลเดอร์ที่มีไฟล์ `<email>.json` หนึ่งไฟล์ต่ออีเมล (`welcome`, `referral`, `model-connection`, `agent-import`) แต่ละไฟล์จับคู่ภาษาของแอป (`en`, `de`, `pt-BR`, ...) กับสตริงของอีเมลนั้นตาม key:

```json
{
  "en": { "subject": "...", "body": "... {weeks} ..." },
  "de": { "subject": "...", "body": "... {weeks} ..." }
}
```

ต้องมีทุก key และแต่ละสตริงต้องใช้ `{placeholders}` ตรงตามที่ key นั้นระบุใน `packages/auth/src/email-copy/email-keys.ts` อีเมลจะถูกส่งเฉพาะเมื่อภาษาอังกฤษในไฟล์มีสตริงที่ถูกต้องครบทุก key สตริงที่หายไปหรือไม่ถูกต้องในภาษาอื่นจะใช้ภาษาอังกฤษนั้นแทน ตอนสตาร์ท API และ worker จะบันทึกว่าอีเมลใดปิดอยู่และเพราะอะไร

แอปอ่านโฟลเดอร์จาก `EMAIL_COPY_DIR` (`/app/email-copy` ใน image) ให้ mount โฟลเดอร์ของคุณไว้ที่นั่นทั้งใน service `api` และ `worker` หรือชี้ `EMAIL_COPY_DIR` ไปที่มัน worker เป็นผู้ส่งอีเมลเตือน จึงต้องได้การตั้งค่าเมลเดียวกับ API (ไฟล์ Compose ทำไว้แล้ว) `node packages/auth/scripts/check-email-copy.ts <dir>` ตรวจโฟลเดอร์และล้มเหลวเมื่อพบสิ่งที่จะทำให้อีเมลไม่ถูกส่งหรือต้องใช้ภาษาสำรอง

## นโยบายรหัสผ่าน

รหัสผ่านใหม่ (สมัคร รีเซ็ต และเปลี่ยน) ต้องยาว 8 ถึง 128 ตัวอักษร ไม่มีกฎบังคับองค์ประกอบ เลือกปฏิเสธรหัสผ่านใหม่ที่ปรากฏในข้อมูลรั่วไหลที่รู้จักได้:

```env
AUTH_BREACHED_PASSWORD_CHECK_ENABLED=true
```

ค่านี้ query range API ของ Have I Been Pwned โดยส่งเพียงห้าตัวอักษรแรกของ SHA-1 hash ของรหัสผ่าน ปิดไว้ตามค่าเริ่มต้นเพื่อให้เซิร์ฟเวอร์ไม่ส่ง request ออกภายนอก ถ้าบริการเข้าถึงไม่ได้หรือใช้เวลานานกว่าสามวินาที รหัสผ่านจะถูกยอมรับและบันทึกความล้มเหลวไว้

## SSO ด้วย OpenID Connect

SSO ใช้กับ OpenID Connect provider ทั้งแบบ self-host และแบบโฮสต์ได้ ไม่ตั้งค่าเหล่านี้ถ้าต้องการใช้การยืนยันตัวตนด้วยรหัสผ่านอย่างเดียว ตั้ง credential ทั้งสามพร้อมกันบน API:

```env
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_NAME=SSO
OIDC_SCOPES=openid email profile
AUTH_PASSWORD_ENABLED=true
OIDC_ALLOW_SIGNUP_BYPASS=false
OIDC_EMAIL_VERIFIED_CLAIM=
OIDC_AUTHORIZATION_PARAMS=
```

issuer ต้องเป็น HTTPS และตรงกับ issuer ใน discovery document ทุกตัวอักษร Rakazo โหลด `<issuer>/.well-known/openid-configuration` ตรวจ ID token กับ JWKS จาก discovery พร้อมตรวจ issuer, audience และ nonce และใช้ authorization code กับ PKCE scope เพิ่มเติมคั่นด้วยช่องว่างหรือจุลภาคได้ `openid email profile` จะถูกขอเสมอ `OIDC_NAME` คือข้อความบนปุ่ม ค่าเริ่มต้นคือ “SSO” secret อยู่บน API เท่านั้น Compose ล้าง OIDC credential ของ worker capabilities endpoint เปิดเผยเพียงข้อความปุ่ม สถานะ discovery และวิธียืนยันตัวตนที่เปิดอยู่

ลงทะเบียน redirect URI นี้ที่ provider (ใช้ origin สาธารณะของ `BETTER_AUTH_URL`):

```text
https://app.example.com/api/auth/callback/oidc
```

เว็บ Electron และมือถือใช้ redirect URI เดียวกัน Electron ทำ SSO ให้เสร็จใน popup ภายในแอปแบบ sandbox ที่ใช้ session ร่วมกับแอป แล้วกลับไปที่หน้าต่างหลัก มือถือทำ callback ให้เสร็จบน API แล้วกลับไปที่ `rakazo://sign-in` (หรือ `rakazo://account` สำหรับการลิงก์และยืนยันตัวตนซ้ำ) ผ่าน Expo authorization proxy ของ Better Auth และ auth browser session แบบ native auth server เชื่อถือ app scheme `rakazo` ห้ามลงทะเบียน client secret ในแอปมือถือ มือถือเก็บ session ที่ได้ด้วย SecureStore เหมือนการลงชื่อเข้าใช้ด้วยรหัสผ่าน build แบบ native ต้องมีโมดูล Expo WebBrowser

อีเมลจาก provider ถือว่ายืนยันแล้วเมื่อ `email_verified` เป็น boolean `true` หรือสตริง `true` ไม่ว่าตัวพิมพ์ใดก็ตาม ค่าอื่นทั้งหมด รวมถึง `false` และ claim ที่ไม่มี จะไม่ถือว่ายืนยันในทุกการลงชื่อเข้าใช้ และ claim ที่ไม่ยืนยันไม่เคยเปลี่ยนอีเมลของบัญชี ถ้า provider ของคุณไม่ส่ง `email_verified` แต่พิสูจน์อีเมลใน claim ของตัวเอง ให้ระบุชื่อ claim นั้นใน `OIDC_EMAIL_VERIFIED_CLAIM` ซึ่งจะอ่านแบบเดียวกัน เฉพาะเมื่อไม่มี `email_verified` สำหรับ Microsoft Entra ID ให้เพิ่ม optional ID token claim `email` และ `xms_edov` ใน **Token configuration** แล้วตั้ง `OIDC_EMAIL_VERIFIED_CLAIM=xms_edov`

การลงชื่อเข้าใช้ไม่เคยลิงก์บัญชีด้วยอีเมล ยกเว้นเพื่อรับบัญชีที่ [directory provisioning](#directory-provisioning-scim) สร้างไว้ ถ้าอีเมลเป็นของบัญชีอื่น ให้ลงชื่อเข้าใช้บัญชีเดิมนั้นแล้วเลือก **Link SSO** ในการตั้งค่าบัญชี การลิงก์ต้องมี session ที่ยืนยันตัวตนแล้ว อีเมลของ provider ที่ยืนยันแล้ว และที่อยู่อีเมลที่ตรงกัน เมื่อส่งอีเมลได้ บัญชีจะลิงก์ SSO ได้หลังยืนยันอีเมลแล้วเท่านั้น ถ้าส่งอีเมลไม่ได้ บัญชีที่ยังไม่ยืนยันจะลิงก์ได้เฉพาะจากเบราว์เซอร์ที่ลงชื่อเข้าใช้บัญชีนั้นอยู่ จึงทำจากแอปมือถือไม่ได้ หลังจากนั้น issuer และ subject ของ provider จะระบุบัญชีที่ลิงก์ การเปลี่ยน issuer ไม่ใช้ตัวตนเดิมซ้ำ ลิงก์ของ issuer เก่ายังถูกเก็บไว้แต่ไม่นับว่าลิงก์กับ provider ปัจจุบัน **Link SSO** จึงใช้ได้อีกครั้ง ให้ลิงก์ตัวตนใหม่จากบัญชีเดิมที่ลงชื่อเข้าใช้อยู่ ซึ่งยังต้องผ่านการตรวจ session ที่ยืนยันตัวตน อีเมลที่ยืนยันแล้ว และอีเมลที่ตรงกัน การกลับไปใช้ issuer เดิมจะทำให้ลิงก์เดิมใช้ได้อีก

การลงชื่อเข้าใช้และการลิงก์ SSO ปกติอาจใช้ session ที่มีอยู่ของ identity provider ซ้ำ จึงไม่ให้หลักฐานการยืนยันตัวตนใหม่สำหรับการลบบัญชี ขั้นตอนยืนยันตัวตนซ้ำที่ชัดเจนในการตั้งค่าบัญชีจะขอ `prompt=login` และ `max_age=0` ผูก callback กับ issuer และ subject ที่ลิงก์ไว้เดิม และต้องให้ session ที่เริ่มขั้นตอนยังใช้ได้อยู่ มีเพียง callback นั้นที่ให้หลักฐานกับ session ที่ได้ ซึ่งหมดอายุห้านาทีหลังการยืนยันตัวตนที่ provider (ความล่าช้าของ callback ไม่ยืดเวลานี้) ID token ที่ตรวจแล้วต้องมี `auth_time` ที่สอดคล้องกับ request นั้น (ยอมให้นาฬิกาคลาดได้ 60 วินาที) และมีอายุไม่ถึงห้านาที claim ที่หายไป เก่า หรือไม่ถูกต้องจะล้มเหลวแบบปิดไว้ก่อน OAuth callback ใช้ได้ครั้งเดียว รวมถึง request ที่เกิดพร้อมกัน การตรวจรหัสผ่านและรหัสลบบัญชีทางอีเมลยังใช้ได้ ส่งรหัสลบบัญชีผ่านการตั้งค่าบัญชีหรือ endpoint `POST /api/auth/delete-user` ที่ป้องกัน CSRF ส่วน GET callback สำหรับการลบถูกปิดไว้

การสมัครผ่าน SSO ทำตามการปิดรับลงทะเบียนและ allowlist ของ deployment ก่อนสร้างบัญชี อีเมลของ provider ที่อยู่ใน allowlist ต้องยืนยันแล้ว การสมัครไม่เคยข้ามการพิสูจน์กล่องเมล `OIDC_ALLOW_SIGNUP_BYPASS=true` รับตัวตนจาก IdP โดยไม่ใช้ allowlist และเงื่อนไขการยืนยันอีเมลของมันอย่างชัดเจน เปิดใช้เฉพาะเมื่อ IdP ควบคุมว่าใครเข้าร่วม deployment นี้ได้ ค่านี้**ไม่**เปิดการลงทะเบียนที่ปิดไว้อีกครั้ง และไม่เปลี่ยน claim การยืนยันอีเมลหรือกฎการลิงก์ บัญชีที่รับเข้าแล้วยังลงชื่อเข้าใช้ได้ขณะที่ปิดรับลงทะเบียน

ตั้ง `AUTH_PASSWORD_ENABLED=false` เพื่อใช้ SSO อย่างเดียว endpoint สำหรับลงชื่อเข้าใช้ สมัคร รีเซ็ต และแก้ไขรหัสผ่านจะถูกปิดฝั่งเซิร์ฟเวอร์ และฟอร์มลงชื่อเข้าใช้จะถูกซ่อน API จะไม่ยอมสตาร์ทในโหมดนี้ เว้นแต่ตั้ง OIDC credential ครบทุกตัว แต่ยังสตาร์ทได้ขณะที่ discovery ใช้ไม่ได้ชั่วคราว: provider ยังลงทะเบียนอยู่ การลงชื่อเข้าใช้คืนข้อผิดพลาดชั่วคราว และการลองซ้ำเบื้องหลังจะกู้คืนได้โดยไม่ต้องรีสตาร์ท discovery โหลดเมื่อใช้ครั้งแรก รีเฟรชเบื้องหลัง และเมื่อล้มเหลวจะเว้นระยะสูงสุดหนึ่งนาที สถานะพร้อมใช้งานสะท้อน discovery ไม่ได้รับประกันว่า token endpoint ของ provider เข้าถึงได้ในขณะนั้น

### คำใบ้การลงชื่อเข้าใช้

`OIDC_AUTHORIZATION_PARAMS` เพิ่มพารามิเตอร์เริ่มต้นให้ทุก request ที่ส่งคนไปยัง provider เขียนเป็นคู่ `name=value` เชื่อมด้วย `&` ค่าถูก form-encode: เขียน `&`, `=` และ `+` เป็น `%26`, `%3D` และ `%2B` เพราะ `+` เปล่า ๆ จะถูกอ่านเป็นช่องว่าง ใช้สำหรับคำใบ้ที่ provider มีให้เพื่อข้ามหน้าเลือกบัญชีหรือองค์กร:

| Provider           | การตั้งค่า                      | ผล                                                                                     |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| Microsoft Entra ID | `domain_hint=example.com`    | ไปที่หน้าลงชื่อเข้าใช้ขององค์กรคุณโดยตรง รวมถึง identity provider แบบ federated ถ้าโดเมนของคุณใช้อยู่ |
| Google Workspace   | `hd=example.com`             | แสดงเฉพาะบัญชีในโดเมนนั้น                                                                  |
| Keycloak           | `kc_idp_hint=<alias>`        | ข้ามหน้าล็อกอินของ Keycloak ไปยัง identity provider ที่ลิงก์ไว้ด้วย alias นั้น                      |
| Okta               | `idp=<identity provider id>` | ส่งคนไปยัง identity provider นั้น                                                          |
| Any                | `prompt=select_account`      | ถามว่าจะใช้บัญชีใด แม้มีบัญชีที่ลงชื่อเข้าใช้อยู่เพียงบัญชีเดียว                                           |

รวมหลายค่าได้ เช่น `domain_hint=example.com&prompt=select_account` แต่ละชื่อใช้ได้ครั้งเดียว provider เป็นผู้ตัดสินว่าจะทำตามคำใบ้หรือไม่ (เช่น tenant ของ Entra ตั้งให้ไม่สน `domain_hint` ได้) จึงควรลองลงชื่อเข้าใช้หนึ่งครั้งหลังตั้งค่า request ลงชื่อเข้าใช้ที่ส่งค่าของพารามิเตอร์เองจะแทนที่ค่าเริ่มต้นนี้ พารามิเตอร์มีผลกับการลงชื่อเข้าใช้บนเว็บ เดสก์ท็อป และมือถือ รวมถึงการลิงก์ เพราะ API เป็นผู้สร้าง request API จะไม่ยอมสตาร์ทถ้าระบุพารามิเตอร์ที่ขั้นตอนลงชื่อเข้าใช้ตั้งเอง (`client_id`, `redirect_uri`, `response_type`, `response_mode`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`, `request` หรือ `request_uri`) การยืนยันตัวตนซ้ำที่ชัดเจนข้างบนยังส่ง `prompt=login` และ `max_age=0` ไม่ว่าตั้งอะไรไว้ที่นี่ คำใบ้เพียงทำให้หน้าจอของ provider สั้นลง ส่วนใครลงชื่อเข้าใช้ได้ยังตัดสินโดย provider และกฎการสมัครของ deployment นี้

การลบบัญชียังใช้การยืนยันด้วยรหัสผ่านเดิมสำหรับผู้ใช้ที่มีรหัสผ่าน ผู้ใช้ที่ไม่มีรหัสผ่านลบบัญชีได้หลังยืนยันตัวตนซ้ำด้วย SSO ขององค์กรอย่างชัดเจนภายในห้านาที **Sign in again** เริ่มการไปกลับ provider ใหม่ที่ผูกกับบัญชีที่ลงชื่อเข้าใช้อยู่ การเลือกตัวตนอื่นไม่สามารถยืนยันการลบหรือสร้างบัญชีอื่นในขั้นตอนนั้นได้ session ที่เก่าหรือยืมมาเพียงอย่างเดียวอนุญาตการลบไม่ได้ เมื่อตั้งอีเมล transactional ไว้ **Send deletion code** จะส่งรหัสใช้ครั้งเดียวไปยังอีเมลของบัญชี ใช้ได้สิบนาที ใส่รหัสในการตั้งค่าบัญชีเพื่อยืนยันการลบ การขอรหัสทางอีเมลถูกจำกัดอัตรา รหัสที่ไม่ถูกต้อง หมดอายุ หรือผิดบัญชีจะล้มเหลว ไม่ต้องสร้างรหัสผ่านเพื่อลบบัญชี

## ลงชื่อเข้าใช้ด้วย Google และ Apple

การลงชื่อเข้าใช้ด้วย Google และ Apple ปิดอยู่จนกว่าคุณจะตั้ง credential บน API ถ้าไม่ตั้งอะไร การลงชื่อเข้าใช้จะเป็นอีเมลและรหัสผ่าน (และ OpenID Connect provider ที่ตั้งไว้แล้ว) แต่ละ provider เปิดเฉพาะเมื่อค่าของตัวเองครบ อีเมลและรหัสผ่านยังใช้ได้ข้างปุ่มเหล่านั้น

```env
GOOGLE_CLIENT_ID=replace-with-client-id
GOOGLE_CLIENT_SECRET=replace-with-client-secret

APPLE_CLIENT_ID=replace-with-services-id
APPLE_TEAM_ID=replace-with-team-id
APPLE_KEY_ID=replace-with-key-id
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace-with-key\n-----END PRIVATE KEY-----"
```

ปล่อยคู่ใดว่างไว้เพื่อปิด provider นั้น `APPLE_PRIVATE_KEY` คือเนื้อหาของไฟล์ `.p8` ของ Sign in with Apple การขึ้นบรรทัดใหม่ในค่า env เป็นบรรทัดใหม่จริงหรือสองตัวอักษร `\n` ก็ได้ ถ้าจะ mount ไฟล์แทน ให้ตั้ง `APPLE_PRIVATE_KEY_FILE` เป็น path ของไฟล์และปล่อย `APPLE_PRIVATE_KEY` ว่าง ตั้งอย่างใดอย่างหนึ่ง ไม่ใช่ทั้งสอง ใน Compose ทุกแบบ path นี้อยู่ใน container ของ API: เพิ่ม override ให้ service `api` พร้อม bind mount แบบอ่านอย่างเดียว เช่น `./secrets/apple.p8:/run/secrets/apple.p8:ro` และตั้ง `APPLE_PRIVATE_KEY_FILE=/run/secrets/apple.p8` ไฟล์ Compose หลักไม่ mount คีย์จากโฮสต์

API ลงนาม client secret ของ Apple เอง (ES256 จากคีย์, team id และ key id) cache ไว้ และลงนามอันใหม่ก่อนหมดอายุ Apple ปฏิเสธ secret ที่ลงวันที่ล่วงหน้าเกินหกเดือน จึงไม่มีอะไรต้องหมุนเอง และไม่มี client-secret JWT ต้องวาง

ลงทะเบียน redirect URI เหล่านี้ โดยใช้ origin สาธารณะของ `BETTER_AUTH_URL`:

```text
https://app.example.com/api/auth/callback/google
https://app.example.com/api/auth/callback/apple
```

สำหรับ Google ให้สร้าง web OAuth client แล้วเพิ่ม redirect URI นั้น สำหรับ Apple ให้สร้าง Services ID (ค่านั้นคือ `APPLE_CLIENT_ID`) เปิด Sign in with Apple บนมัน และให้กลับไปที่ redirect URI เดียวกัน คีย์สร้างใน Keys โดยเปิด Sign in with Apple id ของคีย์คือ `APPLE_KEY_ID` และ team id อยู่ในหน้าบัญชี ดาวน์โหลด `.p8` ได้ครั้งเดียว ให้เก็บไว้กับ secret อื่นของ API

เว็บ เดสก์ท็อป และมือถือใช้ OAuth ผ่านเบราว์เซอร์ด้วย callback URL เดียวกัน iOS แสดงปุ่ม Apple แบบ native เมื่อมี ปุ่มนี้เริ่มการอนุญาตผ่านเบราว์เซอร์ ไม่ได้รับ identity token เปล่า ๆ ไม่รองรับการส่ง token แบบ native เพราะขั้นตอนผ่านเบราว์เซอร์ผูกการอนุญาตไว้กับ state ฝั่งเซิร์ฟเวอร์ที่ใช้ครั้งเดียวและ nonce App Store กำหนดให้ build ที่มี Google ต้องมีตัวเลือก Apple ด้วย

บัญชีที่มีอยู่เชื่อมต่อ Google, Apple หรือ OpenID Connect ทั่วไปผ่านการลิงก์ที่ยืนยันตัวตนแล้วในการตั้งค่าบัญชี อีเมลของ provider กับบัญชีที่ตรงกันไม่เคยลิงก์ให้โดยอัตโนมัติ เพราะการยืนยันของ provider ในอดีตไม่ได้พิสูจน์ว่ายังควบคุมกล่องเมลที่โฮสต์อยู่ที่อื่นในปัจจุบัน

การลิงก์ต้องให้อีเมลที่ยืนยันแล้วของ provider ตรงกับอีเมล Rakazo ที่ยืนยันแล้ว ที่อยู่อื่นของ provider รวมถึงที่อยู่ relay ของ Hide My Email ของ Apple ลิงก์กับบัญชีนั้นไม่ได้

การสมัครผ่าน Google หรือ Apple ทำตามการปิดรับลงทะเบียนและ allowlist เดียวกับการสมัครด้วยอีเมล อีเมลของ provider ต้องยืนยันแล้วก่อนสร้างบัญชี social ใด ๆ การยืนยันของ Google นับเฉพาะ Gmail หรือโดเมน Workspace ที่ยืนยันแล้วและตรงกัน การยืนยันของ Apple นับเฉพาะกล่องเมลที่ Apple จัดการและที่อยู่ relay กล่องเมลอื่นของ provider สร้างบัญชีผ่านการสมัครแบบ social ไม่ได้ ให้ยืนยันบัญชีผ่านอีเมลแล้วลิงก์ในการตั้งค่า

การลงชื่อเข้าใช้และการลิงก์ด้วย Google และ Apple ไม่ยืนยันการกระทำที่อ่อนไหว session ของเบราว์เซอร์อาจถูก cache ไว้ หน้าเลือกบัญชี หน้าขอความยินยอม หรือ nonce ไม่ได้พิสูจน์การยืนยันตัวตนใหม่ ให้ใช้รหัสผ่าน รหัสยืนยันทางอีเมล หรือ OIDC ขององค์กรที่มี `auth_time` ใหม่ที่ตรวจแล้ว บัญชีที่มีแต่ social บนเซิร์ฟเวอร์ที่ไม่มีวิธียืนยันที่รองรับหรือส่งอีเมลไม่ได้ จะยืนยันการกระทำที่อ่อนไหวด้วยตัวเองไม่ได้ รวมถึงการลบบัญชี ผู้ดูแลต้องตั้งวิธีที่รองรับ และ UI จะซ่อนตัวเลือกยืนยันที่ใช้ไม่ได้

## Directory provisioning (SCIM)

identity provider ของคุณเพิ่มและลบคนใน Rakazo ผ่าน SCIM 2.0 ได้ สร้าง token (`openssl rand -hex 32`) แล้วตั้งบน API:

```env
SCIM_BEARER_TOKEN=<your generated token>
```

ใน identity provider ให้ตั้ง SCIM base URL เป็น `https://app.example.com/api/auth/scim/v2` (origin ของ `BETTER_AUTH_URL`) และ bearer token เป็นค่านั้น token จัดการได้เฉพาะผู้ใช้ request ของกลุ่มจะถูกปฏิเสธ การหมุน token คือเปลี่ยนค่าแล้วรีสตาร์ท API

- **การเพิ่มคน** สร้างบัญชีด้วยอีเมลของเขา แบบยังไม่ยืนยันและไม่มีรหัสผ่าน บัญชีเข้า Rakazo ได้แม้ปิดรับสมัครหรือ allowlist จะปฏิเสธ `SIGNUPS_ENABLED=false` ร่วมกับ SCIM จึงรับเฉพาะคนที่ directory กำหนด เขาลงชื่อเข้าใช้ผ่าน [SSO](#sso-ด้วย-openid-connect) (การลงชื่อเข้าใช้ SSO ครั้งแรกด้วยอีเมลเดียวกันที่ยืนยันแล้วจะรับบัญชีไป) หรือด้วยรหัสลงชื่อเข้าใช้ทางอีเมล
- **คนที่มีบัญชีอยู่แล้ว** ยังเก็บบัญชีไว้: directory เข้าดูแลบัญชีโดยอ้างอิงอีเมล โดยไม่เปลี่ยนชื่อ อีเมล หรือวิธีล็อกอิน และปิดบัญชีได้หลังจากนั้น จะเข้าดูแลเฉพาะบัญชีที่ยืนยันอีเมลแล้ว ใครก็อาจสมัครก่อนด้วยที่อยู่ที่ไม่มีใครพิสูจน์ directory จึงได้ conflict สำหรับบัญชีนั้น เช่นเดียวกับเมื่ออีเมลของสองบัญชีต่างกันแค่ตัวพิมพ์ ผู้ดูแลเป็นผู้ตัดสินว่าจะทำอย่างไรกับบัญชีเหล่านั้น
- **การปิดคน** (`active: false`) หรือ**การลบ**เขาจะปิดบัญชีทันที ยุติทุก session และ computer ที่จับคู่ไว้ ลบการลงทะเบียนการแจ้งเตือน ยกเลิกการรันที่เขาเริ่ม ข้าม routine ของเขา และปฏิเสธการลงชื่อเข้าใช้ การรัน การส่ง webhook หรือข้อความใหม่จากแอปแชทที่ลิงก์ไว้ bot แชท memory ไฟล์ และการเชื่อมต่อของเขายังอยู่ เขายังออกจากทุก Space ที่แชร์ซึ่งคนอื่นเชิญเข้าไป เหมือนถูกลบออก: สิ่งที่เขาสร้างไว้ที่นั่นตกเป็นของเจ้าของ Space นั้น และ routine ของเขาที่นั่นถูกหยุดพัก Space ที่เขาเป็นเจ้าของยังเป็นของเขา
  การเปิดกลับจะคืนการลงชื่อเข้าใช้และ Space ของเขาเอง และ routine ในนั้นจะทำงานต่อจากเวลาที่กำหนดถัดไป Space ที่แชร์ซึ่งเขาออกไปแล้วต้องเชิญใหม่
- **การเพิ่มคนที่ถูกลบกลับมา** ด้วย external id เดิมจะพบบัญชีเดิมของเขา

ถ้าไม่มี identity provider ผู้ดูแลทำแบบเดียวกันได้จาก container ของ API:

```bash
docker compose --env-file .env -f docker-compose.images.yml exec api \
  node dist/cli/account-status.js deactivate person@example.com   # or reactivate
```

ขณะที่ตั้ง `SCIM_BEARER_TOKEN` อยู่ คำสั่งนี้จะปล่อยบัญชีที่ identity provider จัดการไว้ให้ provider: จะไม่ปิดบัญชีที่ provider เปิดอยู่ และไม่เปิดบัญชีที่ provider ปิดหรือลบไป เมื่อลบ token ออกแล้ว คำสั่งจะเปลี่ยนบัญชีใดก็ได้ คำสั่งเดียวกันนี้ทำการปิดบัญชีที่การเก็บกวาดล้มเหลวให้เสร็จ การลงชื่อเข้าใช้และการรันถูกปฏิเสธทันทีที่บัญชีปิด และ API บันทึก `directory.account_change.unfinished` พร้อม id ของบัญชี ถ้าการยุติ session, computer หรือการรันไม่เสร็จ

การปิดและเปิดบัญชีกลับถูกบันทึกเป็น [เหตุการณ์ความปลอดภัย](../self-host-observability.md#security-events) `auth.account.deactivated` และ `auth.account.reactivated` และใน [audit log](../self-host-audit-log.md) ของทุกองค์กรของคนนั้น directory ไม่เคยลบบัญชีหรือเนื้อหาของบัญชี

## Passkeys

passkey เปิดเมื่อ `WEB_ORIGIN` เป็นโดเมน HTTPS (หรือ `localhost` ตอนพัฒนา) relying party คือโฮสต์ของ origin นั้น passkey ที่มีอยู่จึงใช้ได้ต่อเฉพาะขณะที่ `WEB_ORIGIN` ยังอยู่บนโดเมนเดิม passkey ปิดเมื่อปิดการลงชื่อเข้าใช้ด้วยรหัสผ่านสำหรับ deployment ที่ใช้ SSO อย่างเดียว บนเว็บ เบราว์เซอร์จะเสนอ passkey เมื่อมี platform authenticator แอปเดสก์ท็อป macOS ใช้หน้าต่าง passkey ของระบบ ซึ่งให้บริการเฉพาะโดเมนที่ release ผูกไว้ (`app.rakazo.com`) จึงซ่อน passkey สำหรับเซิร์ฟเวอร์อื่น

แอป native ใช้ passkey ของโดเมนได้เฉพาะเมื่อโดเมนรับรองแอปนั้น และแอปถูก build สำหรับโดเมนนั้น associated domain ของแอป iOS มาจาก `EXPO_PUBLIC_API_URL` ตอน build build ของเดสก์ท็อป macOS ใช้ค่าจาก `RAKAZO_PASSKEY_RP_ID` (ค่าเริ่มต้น `app.rakazo.com`): ตั้งเป็นโดเมนเดียวกันสำหรับ `pnpm build` และ `apps/desktop/scripts/passkey-entitlements.ts` แล้ว package ด้วย electron-builder โดยตั้ง `-c.mac.entitlements` เป็นผลลัพธ์ของสคริปต์นั้น และ `-c.mac.provisioningProfile` เป็น profile สำหรับ App ID ของคุณที่มี capability Associated Domains แบบเดียวกับ release workflow ถ้าขาดอย่างใดอย่างหนึ่ง macOS จะไม่สนการผูกโดเมนและแอปจะซ่อน passkey เมื่อ CDN ของ Apple เข้าถึงเซิร์ฟเวอร์ไม่ได้ (เครือข่ายส่วนตัวหรือ VPN อย่าง Tailscale) ให้ตั้ง `RAKAZO_PASSKEY_DEVELOPER_MODE=1` สำหรับ build ใดก็ได้ด้วย แอปที่ลงนามแบบ development จะดึงไฟล์ association เอง เมื่อเปิด associated-domains developer mode แล้ว (Settings > Developer บน iOS หรือ `sudo swcutil developer-mode -e true` บน macOS ซึ่งแอปต้องอยู่ใน `/Applications` ด้วย) ถ้าจะให้ build ใช้ passkey ของเซิร์ฟเวอร์นี้ ให้ตั้ง:

```bash
# iOS and the macOS desktop app (dev.rakazo.desktop): <Apple Team ID>.<bundle id>, comma-separated.
# Served as /.well-known/apple-app-site-association.
PASSKEY_APPLE_APP_IDS=ABCDE12345.com.rakazo.app,ABCDE12345.dev.rakazo.desktop
# Android: SHA-256 fingerprints of the app signing certificates, comma-separated.
# Served as /.well-known/assetlinks.json and accepted as passkey origins.
PASSKEY_ANDROID_CERT_SHA256=AA:BB:...:FF
```

จนกว่าจะตั้งค่าของแพลตฟอร์มใด แอป native บนแพลตฟอร์มนั้นจะซ่อน passkey สำหรับเซิร์ฟเวอร์นี้ ทั้งสองไฟล์ให้บริการผ่าน web origin reverse proxy ที่อยู่หน้า container เว็บจึงต้องส่ง `/.well-known/` ต่อไปให้มัน
