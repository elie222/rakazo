# Self-host Rakazo

[English](../self-host.md) | ไทย

รัน API, worker, เว็บแอป, ฐานข้อมูล และ computer ของ bot บนเครื่องที่คุณควบคุม
ดูการเปรียบเทียบกับ AI agent แบบ self-host ตัวอื่นได้ที่หน้า [self-hosted AI agent](https://rakazo.com/self-hosted-ai-agent/#other-agents)

ผลิตภัณฑ์ส่วนที่ต้องลงชื่อเข้าใช้ประกอบด้วย API ที่รันตลอดเวลา, Graphile Worker, Postgres และ computer provider (Docker supervisor, E2B, Daytona, CreateOS หรือ Boat) ไม่ใช่เว็บไซต์ static ส่วนเว็บไซต์การตลาดใน `apps/www` โฮสต์แยกได้

## สิ่งที่ต้องมี

- Docker Engine 26 ขึ้นไป พร้อม Compose plugin, curl และ OpenSSL สำหรับ published images ไม่ต้องใช้อย่างอื่น
- โมเดล: คีย์ OpenRouter, connection ที่เพิ่มในแอปหลังสมัคร หรือเซิร์ฟเวอร์โมเดลที่คุณรันเอง ([โมเดล](./self-host-models.md))
- สำหรับโฮสต์สาธารณะ: โดเมนและ TLS ([deploy บน production](./self-host-production.md))

## Published images (ไม่ต้อง checkout)

ดึง Postgres และ `ghcr.io/elie222/rakazo/app` ลงโฟลเดอร์ว่างใดก็ได้ ไม่ต้อง clone หรือ build image
ต้องมี Docker Engine 26 ขึ้นไป (API 1.45 ขึ้นไป สำหรับ subpath ของ volume home ของ bot), Compose plugin, curl และ OpenSSL

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

ตัวติดตั้งจะดาวน์โหลด `docker-compose.images.yml` และ `.env.images.example` สร้าง `.env` พร้อม secret แบบสุ่ม แล้วดึงและสตาร์ท image การรันซ้ำจะเก็บ `.env` เดิมไว้ รายการ secret ที่ตัวติดตั้งสร้าง กฎห้ามใช้ค่าซ้ำ และการกู้คืน ดูที่ [รายการตรวจ secret สำหรับ self-host](./self-host-secrets.md) ถ้าจะปรับ URL สาธารณะ, tag ของ image หรือ provider เสริมก่อนสตาร์ท ให้รัน `bash install-images.sh --prepare-only` แก้ `.env` แล้วรัน `bash install-images.sh` ใช้ flag ร่วมกันได้ในลำดับใดก็ได้: `--prepare-only`, `--local`
เมื่อ `RAKAZO_IMAGE_TAG` เป็น release เช่น `v0.8.0` ตัวติดตั้งจะดาวน์โหลดไฟล์ Compose จาก release นั้นแทน `main`

`SANDBOX_PROVIDER` มีค่าเริ่มต้นเป็น `docker` ไฟล์ Compose ของ images จะรัน sandbox supervisor (จาก app image บนเครือข่ายภายในเท่านั้น) และดึง `ghcr.io/elie222/rakazo/computer` การสมัครและ Docker computer บนเครื่องใช้งานได้โดยไม่ต้องมีบัญชี E2B ถ้าจะใช้ provider ระยะไกล ให้ตั้ง `SANDBOX_PROVIDER` เป็น `e2b`, `novita`, `daytona`, `createos` หรือ `boat` แล้วใส่ API key ที่ตรงกัน Compose stack ของ published images ต้องมี `SANDBOX_SUPERVISOR_TOKEN` สำหรับทุก provider ถ้าปล่อยว่าง `compose up` จะล้มเหลวแบบปิดไว้ก่อน

ไม่บังคับ: ตั้ง `OPENROUTER_API_KEY` หรือเชื่อมต่อโมเดลใน UI หลังสมัคร provider อื่น โมเดล local และการอนุมัติ ดูที่ [โมเดล](./self-host-models.md)

ตัวอย่างใช้ค่าเริ่มต้น `latest` ซึ่งติดตามเฉพาะ release เสถียร ทุกการเผยแพร่เป็น multi-arch (`amd64` + `arm64`) โฮสต์ arm64 จึงไม่ต้องใช้ tag พิเศษ ต้องมี release เสถียรอยู่แล้ว การติดตั้งจะไม่ย้อนไปใช้ build จาก main การอัปเดตอัตโนมัติปิดไว้ตามค่าเริ่มต้น เปิดใช้ได้ที่ [อัปเดตรุ่นเสถียรตามกำหนดเวลา](./self-host-upgrading.md#อัปเดตรุ่นเสถียรตามกำหนดเวลา) ถ้าต้องการ

เปิด [http://127.0.0.1:5173](http://127.0.0.1:5173) การสมัครไม่เคยให้สิทธิ์ดูแลเซิร์ฟเวอร์ สำหรับโฮสต์สาธารณะ ให้วาง TLS ไว้หน้า `:5173` และตั้ง origin สาธารณะทั้งสามเป็น HTTPS URL นั้น

Compose ของ images bind เว็บไว้ที่ loopback (`127.0.0.1:5173`) ให้จบ TLS บนโฮสต์แล้ว proxy มาที่นั่น Vite preview proxy `/api` และ `/rpc` แบบ same-origin จึงไม่ต้องเปิด `:3100` ออกภายนอก ตั้ง `BETTER_AUTH_URL`, `WEB_ORIGIN` และ `API_URL` เป็น HTTPS origin เดียวกันนั้น และตั้ง `RAKAZO_HOST` เป็นชื่อโฮสต์ (เช่น `app.example.com`) cookie และ CORS จะยึดตาม origin เหล่านี้

ถ้าต้องการเข้าเว็บแอปด้วยชื่อโฮสต์อื่นด้วย (เช่น IP ใน LAN หรือชื่อใน tailnet) ให้ใส่ชื่อเหล่านั้นคั่นด้วยจุลภาคใน `RAKAZO_ALLOWED_HOSTS` Vite preview จะปฏิเสธ header `Host` อื่น และหน้าจอ computer จะว่างเปล่า

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

เปิด **Agent computer** บน bot หรือส่งข้อความที่ใช้เดสก์ท็อป เพื่อดู Docker computer บนเครื่อง ถ้าต้องการ Caddy ใน stack ร่วมกับ E2B computer ระยะไกล ให้ใช้เส้นทาง [Compose สำหรับ production](./self-host-production.md#deploy-บน-vm-เดียวแบบสาธารณะ) และ `infra/compose/Caddyfile.prod` แทน proxy บนโฮสต์นี้

### เครือข่ายที่ถูกจำกัดหรือดาวน์โหลดผ่าน mirror

ถ้าตัวติดตั้ง การดาวน์โหลดของ Compose หรือการดึง image ถูกบล็อก ให้ดู [คู่มือเครือข่ายที่ถูกจำกัด](../self-host-restricted-network.md) สำหรับการตั้งค่า mirror และไฟล์ local

## Docker Compose (เครื่องเดียว)

1. คัดลอก `.env.example` เป็น `.env` แล้วตั้ง `POSTGRES_PASSWORD` และ `POSTGRES_APP_PASSWORD` (อันละ `openssl rand -hex 16`) รวมถึง `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` และ `SCREEN_PROXY_SECRET` เป็นสตริงสุ่มยาวที่ไม่ซ้ำกัน (32 ตัวอักษรขึ้นไป และ 64 hex สำหรับ `ENCRYPTION_KEY`) Docker sandbox ต้องมี `SANDBOX_SUPERVISOR_TOKEN` แยกต่างหากด้วย เก็บค่า `ENCRYPTION_KEY` เดิมไว้เพื่อให้ยังถอดรหัส credential ที่เก็บไว้ได้
2. ไม่บังคับ: ตั้ง `OPENROUTER_API_KEY` เพื่อเป็น model connection สำหรับทั้ง deployment หรือเพิ่ม model connection ในแอปหลังสมัคร ตั้ง `COMPOSIO_API_KEY` เฉพาะเมื่อต้องการ Plugins
3. build image ของ computer: `pnpm sandbox:build` (Compose ก็ build ให้ผ่าน service `computer` เช่นกัน)
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. เปิด web origin (ค่าเริ่มต้น `http://127.0.0.1:5173`) การสมัครไม่เคยให้สิทธิ์ดูแลเซิร์ฟเวอร์

บน Windows ถ้า clone เก่าที่ตั้ง `core.autocrlf=true` ทำให้แผง computer ค้างตอนบูต (เห็น `bash\r` ใน log ของ sandbox) ให้ตั้ง `git config core.autocrlf false` จาก worktree ที่สะอาด รัน `git add --renormalize . && git checkout -- .` แล้ว build ใหม่ด้วย `pnpm sandbox:build`

Compose รัน Postgres, sandbox supervisor (Docker socket), API, worker และ Vite preview ของเว็บแอป computer ของ bot เป็น container พี่น้อง (`rakazo/computer:local`) บนเครือข่ายแยกต่อ bot มีเพียง supervisor และ screen proxy ที่เข้าร่วมแต่ละเครือข่าย process ของ API ไม่ได้รับ Docker socket แบบไม่จำกัด supervisor เป็นผู้ดูแล lifecycle

Postgres อยู่ในเครือข่าย Compose เท่านั้น (ไม่ publish บนโฮสต์) เหมือน Compose ของ images credential มาจาก `.env` (ต้องมี `POSTGRES_PASSWORD`) ควรใช้ค่าที่ปลอดภัยใน URI (`openssl rand -hex 16`) อักขระอย่าง `@ : / ? # %` จะทำให้ `DATABASE_URL` ที่ Compose แทนค่าไว้เสีย image ทางการของ Postgres ตั้ง user, password และ database เฉพาะตอน init volume ครั้งแรก volume ฐานข้อมูลที่มีอยู่จึงคงตัวตนเดิมไว้: เก็บค่าเหล่านั้นใน `.env` หรือเปลี่ยนในที่ด้วย `ALTER ROLE` / rename สร้าง volume ใหม่เฉพาะหลังสำรองข้อมูลแล้ว (หรือเมื่อข้อมูลทิ้งได้) `docker compose down -v` จะลบ state ของ Postgres ทั้งหมด สำหรับไคลเอนต์ฝั่งโฮสต์ (`pnpm db:migrate`, เครื่องมือ GUI) ให้เพิ่ม `infra/compose/docker-compose.postgres-host.yml` เพื่อ publish Postgres ที่ loopback `127.0.0.1:5433` หรือใช้
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`
อย่า publish Postgres บน interface สาธารณะ

## Local (source checkout)

เหมือน quick start ใน README: `.env` จาก `.env.example`, `pnpm sandbox:build`, `pnpm dev` แล้วเปิด URL ที่พิมพ์ออกมา (ค่าเริ่มต้น [http://127.0.0.1:5173](http://127.0.0.1:5173) หรือ `http://localhost:5173` ทั้งสองโฮสต์ loopback เชื่อถือได้) Electron: รัน `pnpm --filter @rakazo/desktop dev` ขณะที่ stack นั้นทำงานอยู่ แล้วเลือก **Existing instance** พร้อมที่อยู่นั้น ตัวเลือก **This computer** ของแอปเดสก์ท็อปจะจัดการ stack local แยกอีกชุด ใช้พอร์ต 45173 เป็นค่าเริ่มต้นเพื่อรันคู่กับ `pnpm dev` ได้ ถ้าพอร์ตนั้นถูกใช้อยู่ แอปจะเลือกและจำพอร์ต loopback อื่น traffic ทั้งหมดของเดสก์ท็อปใช้ web origin เซิร์ฟเวอร์นั้นเข้าถึงได้จากเครื่องเดียวกันเท่านั้น โทรศัพท์จึงเชื่อมต่อไม่ได้ ดู [Desktop "This computer" servers](../self-host-clients.md#desktop-this-computer-servers)

บน Mac ชิป Apple silicon ที่ใช้ macOS 26 ขึ้นไป build ที่มี server bundle รัน stack นี้ได้โดยไม่ต้องใช้ Docker การตั้งค่าใหม่จะใช้เส้นทางนี้ และดาวน์โหลดเซิร์ฟเวอร์กับ runtime ของ computer ตามที่ต้องใช้ การตั้งค่า Docker เดิมจะได้รับข้อเสนอให้ย้ายขณะ Docker ทำงานอยู่ **Keep Docker** จะคงเส้นทาง Docker ไว้ การย้ายจะคัดลอก bot และข้อมูล แล้วหยุด Docker stack เดิมโดยไม่ลบทิ้ง เซิร์ฟเวอร์แบบไม่ใช้ Docker จะหยุดเมื่อปิดแอปเดสก์ท็อป

build และแพลตฟอร์มอื่นใช้ Docker Compose กับ published images (ดู [Published images](#published-images-ไม่ต้อง-checkout)) API ที่แอปจัดการจะได้พอร์ต loopback ที่ Docker กำหนดให้ container Docker เหล่านี้ยังทำงานต่อหลังปิดแอป **Quit and Stop Bots** ในเมนูแอปจะหยุด stack ที่แอปจัดการแล้วปิดแอป ใช้ได้กับทั้งสอง runtime การสลับไปเซิร์ฟเวอร์อื่นก็หยุด stack นั้นเช่นกัน build สำหรับพัฒนาที่ไม่ได้ package ปกติไม่มี server bundle ให้ใช้ **Existing instance** กับ stack พัฒนาจาก source

สำหรับการพัฒนาจาก source ใน WSL ให้เก็บ checkout และไดเรกทอรี `data` ไว้ใน filesystem ของ Linux (เช่น `~/rakazo`) และรัน `pnpm dev` ด้วยผู้ใช้ปกติ supervisor ที่รันบนโฮสต์จะตั้ง UID/GID ของ container bot ให้ตรงกับผู้ใช้นั้น ถ้าเข้าถึง IP ของ container ใน Docker Desktop ไม่ได้ ให้ตั้ง `SANDBOX_CONTROL_VIA_LOOPBACK=true` ใน `.env` ซึ่งจะ publish control service ที่ป้องกันด้วย token บนพอร์ต loopback แบบสุ่ม ไม่ต้องตั้งค่านี้สำหรับ supervisor ที่รันใน Compose

home ของ bot ใน Compose mount เฉพาะไดเรกทอรีย่อยของตัวเองใน volume ของแอป ตามหลักการของ Docker volume path ภายในของ volume Docker ไม่เคยถูกใช้เป็น bind mount ของโฮสต์

## ตั้งค่าและดูแล

- [การตั้งค่า](./self-host-configuration.md): การตั้งค่าไปถึงแต่ละ service อย่างไร ขีดจำกัดการรัน ฐานข้อมูล และ proxy ขาออก
- [Secrets](./self-host-secrets.md): คีย์ที่จำเป็นและวิธีเก็บรักษา
- [การลงชื่อเข้าใช้และบัญชี](./self-host-accounts.md): ใครสมัครได้ [การตั้งค่าทีม](./self-host-accounts.md#ตั้งค่าทีม) อีเมล SSO passkey และรหัสผ่าน
- [โมเดล](./self-host-models.md): provider ของโมเดล โมเดล local การอนุมัติ การสร้างสื่อ และเสียง
- [เครื่องมือและการเชื่อมต่อ](../self-host-integrations.md): การค้นเว็บ, memory, MCP server, แอปแชท, cloud coding agent และการชำระเงิน
- [ที่อยู่อีเมลของ bot](../self-host-inbound-email.md): ที่อยู่สำหรับแต่ละ bot เพื่อให้เมลที่คุณ forward หรือ CC ไปเริ่ม routine ของมัน
- [Webhook บนเครือข่ายส่วนตัว](../self-host-webhooks.md): รับ webhook ขณะที่แอปยังอยู่บน tailnet, LAN หรือ VPN
- [Computer provider](../self-host-sandbox-providers.md) และ [Docker computer](../self-host-docker-computers.md): computer ของ bot รันที่ไหนและถูกจำกัดอย่างไร
- [การติดตั้ง Kubernetes / k3s](../self-host-kubernetes.md): สูตรแบบ node เดียวทีละขั้น การแยก computer และการแก้ปัญหา login gate ([한국어](../ko-KR/self-host-kubernetes.md))
- [Storage และการเข้ารหัส](../self-host-storage.md): การเข้ารหัสเนื้อหา object storage และขีดจำกัดการอัปโหลด
- [Deploy บน production](./self-host-production.md): ติดตั้งบน VM เดียวแบบสาธารณะพร้อม HTTPS อัตโนมัติ
- [สำรองและกู้คืน](./self-host-backups.md) และ [อัปเกรด](./self-host-upgrading.md)
- [Log และการเฝ้าระวัง](../self-host-observability.md): log รายงานข้อผิดพลาด trace เหตุการณ์ความปลอดภัย และการแจ้งเตือน
- [Audit log](../self-host-audit-log.md): ใครทำอะไรในแต่ละองค์กร ระยะเก็บรักษา การ export และการส่งต่อไป SIEM
- [แอปและไคลเอนต์](../self-host-clients.md): แอปมือถือและเดสก์ท็อป push การอัปเดตไคลเอนต์ และการตั้งค่าหน้าเว็บ
- [Billing](../self-host-billing.md): แพ็กเกจ Stripe และเครดิตโมเดลแบบไม่บังคับ
- [เครือข่ายที่ถูกจำกัด](../self-host-restricted-network.md): mirror เมื่อการดาวน์โหลดถูกบล็อก

## คำสั่งผู้ดูแล

`admin.js` รันงานของผู้ดูแลจาก container ของ API ต้องเข้า shell ของเซิร์ฟเวอร์ได้ และไม่เปิดพอร์ตใด

```bash
docker compose --env-file .env -f docker-compose.images.yml exec api \
  node dist/cli/admin.js bot webhook-key <bot-id> [--rotate] [--json]
```

`bot webhook-key` ให้ webhook key ใหม่กับ bot ที่ยังไม่มี แล้วพิมพ์ webhook URL ของมัน ([ที่อยู่ webhook ที่เผยแพร่](../self-host-webhooks.md) ถ้ามี ไม่เช่นนั้นใช้ `API_URL` ต่อด้วย `/api/v1/bots/<bot-id>/webhook`) พร้อมกับคีย์ ถ้า bot มีคีย์อยู่แล้ว จะพิมพ์เฉพาะ URL ส่วน `--rotate` จะแทนที่คีย์ และคีย์เดิมจะใช้ไม่ได้อีก `--json` พิมพ์บรรทัดเดียว `{"botId","url","key","created"}` สำหรับส่งต่อให้โปรแกรมอื่น เพื่อไม่ให้คีย์ไปอยู่ในแชทหรือ log คีย์ใหม่แต่ละอันจะถูกบันทึกเป็น [เหตุการณ์ความปลอดภัย](../self-host-observability.md#security-events) `credential.changed` พร้อม `by: operator`

### การลบบัญชีและ billing

รันคำสั่งเหล่านี้จาก container ของ API ถ้าไม่ใส่ `--confirm` จะแสดงตัวอย่างเป้าหมายและการกระทำเท่านั้น

```sh
node dist/cli/admin.js account delete person@example.test --confirm
node dist/cli/admin.js billing cancel person@example.test --confirm
node dist/cli/admin.js billing refund person@example.test EXAMPLE-0001 --confirm
```

- **การลบบัญชี** ใช้ขั้นตอนเก็บกวาดเดียวกับใน Settings ลบบัญชีและ Space ที่ผูกกับบัญชีอย่างถาวร ยกเลิก subscription และต้องมีตัวรันงานของฐานข้อมูล
- **การยกเลิก billing** จะจบ subscription ขององค์กรที่เลือกทันที และทำให้ checkout ที่ค้างอยู่หมดอายุ ถ้าบัญชีเป็นเจ้าของหลายองค์กรที่มี billing ให้ใส่ ID ขององค์กรหลังอีเมล
- **การคืนเงิน billing** คืนเต็มจำนวนของ invoice ที่ชำระแล้วซึ่งมีการตัดบัตรครั้งเดียวและไม่มีข้อโต้แย้ง ตรวจ invoice และการใช้เครดิตก่อนยืนยัน การคืนเงินค่าซื้อเครดิตโมเดลจะกระทบยอดผ่านการซิงก์ billing ตามปกติ ใช้คำสั่งยกเลิกแยกต่างหากเพื่อจบแพ็กเกจที่ต่ออายุอัตโนมัติ

## รายงานปัญหา

แนบรายงาน diagnostics ไปกับ [issue ของ self-host](https://github.com/elie222/rakazo/issues/new?template=self-host.yml):

```bash
docker compose -f docker-compose.images.yml exec api node dist/cli/diagnostics.js
```

จาก checkout ให้ใช้ `-f infra/compose/docker-compose.yml` (หรือไฟล์ production) แทน รายงานแสดง revision ฟีเจอร์ที่เปิดอยู่ สถานะ migration MCP server ของแต่ละ bot พร้อมสถานะ และการรันล่าสุด ไม่พิมพ์ secret ค่าการตั้งค่า ชื่อ ที่อยู่ path หรือเนื้อหาข้อความ เซิร์ฟเวอร์ bot และการรันจะแสดงเป็น hash สั้น ๆ เท่านั้น

เมื่อผู้ใช้ขอให้ bot รายงานบั๊กหรือส่งความคิดเห็น รายงานจะถูกบันทึกบนเซิร์ฟเวอร์ของคุณในตาราง `feedback_reports` พร้อมแชท bot และการรันที่มา ไม่มีอะไรถูกส่งไปยังโปรเจกต์ Rakazo
