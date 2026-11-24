# การตั้งค่า

[English](../self-host-configuration.md) | ไทย

Rakazo อ่านการตั้งค่าจากตัวแปรสภาพแวดล้อม ปกติเก็บในไฟล์ `.env` ข้างไฟล์ Compose

## ที่อยู่ของการตั้งค่า

แต่ละบริการอ่านการตั้งค่าตอนเริ่มทำงาน หลังเปลี่ยนค่าจึงต้อง restart บริการที่อ่านค่านั้น `.env.example` (source checkout) และ `.env.images.example` (published images) มีรายการค่าที่ใช้บ่อยพร้อมคำอธิบายสั้น ๆ

อย่า commit `.env` อย่าใส่ `COMPOSIO_API_KEY`, key ของ OpenRouter หรือ token ของผู้ให้บริการไว้ใน git, log หรือแชท

## ค่าที่คุณตั้งชื่อเอง

ไฟล์ Compose ส่งให้ API และ worker เฉพาะค่าที่แต่ละตัวอ่าน โดยระบุทีละชื่อ ไม่ได้ส่งทั้ง `.env` ค่าที่คุณตั้งชื่อเอง เช่น `TELEGRAM_BOT_TOKEN_<NAME>` หรือ `PHOTON_PROJECT_ID_<NAME>` จึงต้องมีบรรทัดของตัวเอง: เพิ่มไว้ใต้ `environment` ของ `api` และ `worker` ในไฟล์ override ที่ซ้อนหลังไฟล์หลัก (และใน `RAKAZO_COMPOSE_FILE` ถ้าเปิด updater) โดยไม่ใส่ค่า เพื่อให้ Compose ดึงค่าจาก `.env` `install-images.sh` จะบอกชื่อค่าใน `.env` ที่ไม่มีคอนเทนเนอร์ใดได้รับ

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
  worker:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
```

`install-images.sh` ซ้อน `docker-compose.override.yml` ที่อยู่ข้างกันให้อัตโนมัติ ถ้ารันคำสั่งเอง ให้เพิ่ม `-f docker-compose.override.yml` หลังไฟล์หลัก

## ค่าหลัก

ค่าทั้งหมดนี้เป็นทางเลือก:

```env
RAKAZO_EXTRA_AUTH_ORIGINS=   # extra origins allowed to sign in and call the API; see below
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SCIM_BEARER_TOKEN=        # lets your identity provider add and remove accounts; see self-host-accounts.md
SANDBOX_PROVIDER=docker   # or none, e2b, novita, daytona, createos, boat. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause or stop after 10 minutes idle; 0 disables idle sleep
# Set 0 when self-hosting with Docker, where an idle computer costs nothing, to keep long-running apps and sessions up.
# E2B, CreateOS and Boat still apply their own timeouts.
COMPUTER_MAX_ACTIVE_MS=7200000 # uptime cap for providers that bill while running; minimum 60000; 0 disables
COMPUTER_MAX_ACTIVE_UNBILLED_MS=0 # uptime cap for providers that do not bill while running (Docker, Kubernetes, Incus); minimum 60000; 0 (default) disables; needs SANDBOX_IDLE_MS on
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes; values above 3600000 (1 hour) use 3600000
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited; any non-integer fails at startup
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user length cap; narration stays at 500
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
NOVITA_API_KEY=           # when SANDBOX_PROVIDER=novita; build its template first
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOAT_API_KEY=             # when SANDBOX_PROVIDER=boat
```

`STUCK_WORK_NOTIFY_AFTER_MS` (ค่าเริ่มต้น `14400000` คือ 4 ชั่วโมง) คือเวลาที่ run ที่อยู่ในคิวรอได้ก่อน worker ส่งข้อความเตือนว่า "ยังรออยู่" `STUCK_WORK_EXPIRE_AFTER_MS` (ค่าเริ่มต้น `86400000` คือ 24 ชั่วโมง) คือเวลาก่อน worker หยุด run นั้น ทิ้งบรรทัดสถานะไว้ใน thread และคืน computer ของ bot ทั้งสองค่ารับมิลลิวินาทีตั้งแต่ `60000` ถึง `2592000000` (30 วัน) ค่าอื่นจะใช้ค่าเริ่มต้น ถ้าตั้งเวลาหมดอายุต่ำกว่าเวลาเตือน จะข้ามการเตือนไป คำขอ takeover ที่ไม่มีใครตอบยังหยุดหลัง 30 นาทีเหมือนเดิม `UNATTENDED_APPROVAL_EXPIRE_AFTER_MS` (ค่าเริ่มต้น `1800000` คือ 30 นาที) คือเวลาที่การ์ดขออนุมัติจาก run ที่ไม่มีคนดูแลเปิดรอไว้ก่อนการกระทำจะถูกยกเลิก ใช้ช่วงค่า `60000` ถึง `2592000000` เดียวกัน และการ์ดจากแชทที่มีคนอยู่จะเปิดรอจนกว่าจะมีคนตอบ รายการ activity ยังคงทำเครื่องหมาย run ในคิวที่เก่ากว่า 4 ชั่วโมง คำถามที่ bot ถามจะเปิดรอจนกว่าจะมีคนตอบ เว้นแต่ run นั้นถือ login หรือรหัสที่ขอไว้ใช้เอง run แบบนั้นยังหยุดเมื่อถึงเวลาหมดอายุ

`MODEL_STREAM_MAX_RETRIES` (0 ถึง 5 ค่าเริ่มต้น `1`) ลองใหม่เมื่อ stream ของโมเดลล้มเหลวกลางทาง การลองใหม่มากขึ้นช่วยให้ turn ที่ยาวรอดจากความขัดข้องสั้น ๆ ของผู้ให้บริการ

ตั้งระยะหมดเวลาของโมเดลได้ในหน่วยมิลลิวินาที ค่าที่ไม่ถูกต้องหรืออยู่นอกช่วงจะใช้ค่าเริ่มต้น ระยะที่ยาวขึ้นช่วยได้เมื่อหลาย bot ใช้ inference server ในเครื่องร่วมกันและ server ต่อคิวคำขอ สำหรับ server ใน `RAKAZO_LOCAL_MODELS` และการเชื่อมต่อโมเดลแบบ compatible ที่เพิ่มในแอป ค่าเหล่านี้เป็นขีดจำกัดเดียวที่ Rakazo ใช้ และ stream ที่ถูกตัดจะบอกเหตุผลไว้ในรายละเอียด error ของ run เช่น `terminated (other side closed)` ผู้ให้บริการในตัวยังตัด response ที่ไม่มีข้อมูลนาน 5 นาที และ proxy หรือ load balancer ที่อยู่ระหว่างทางอาจตัด stream ที่เงียบเร็วกว่านั้น

- `MODEL_STREAM_TIMEOUT_MS` (ค่าเริ่มต้น `120000` ช่วง `1000`–`2147483647`) คือเวลารวมสำหรับการลองใหม่กับโมเดลเดิม และยังคุมเวลารอ response header เมื่อใช้ OpenAI Chat Completions, Responses หรือ Codex API, Anthropic Messages, Mistral หรือ Azure OpenAI API อื่น เช่น Google, Vertex AI, Bedrock และโมเดลที่ route ผ่านบางตัว ใช้ timeout ของ client ตัวเอง
- `MODEL_STREAM_IDLE_TIMEOUT_MS` (ค่าเริ่มต้น `180000` ช่วง `0`–`2147483647`) จำกัดเวลาที่ response ที่เริ่มแล้วเงียบได้ ตั้งเป็น `0` เพื่อปิดตัวเฝ้าความเงียบของ Rakazo ยังยกเลิกคำขอเองได้ การปิดการป้องกันนี้อาจทำให้คำขอที่ค้างรอไปเรื่อย ๆ ถ้าทั้งผู้ให้บริการและผู้เรียกไม่ยุติคำขอ
- `MODEL_CONNECT_TIMEOUT_MS` (ค่าเริ่มต้น `30000` ช่วง `1000`–`300000`) จำกัดเวลาเชื่อมต่อกับโมเดลหรือ speech connection แบบ OpenAI-compatible ที่เพิ่มในแอป server ใน `RAKAZO_LOCAL_MODELS` และผู้ให้บริการในตัวยังใช้ connection timeout ของ Node

### เข้าถึง Rakazo จากที่อยู่ที่สอง

การ sign-in และการเรียก API รับเฉพาะจาก `WEB_ORIGIN`, `API_URL`, `BETTER_AUTH_URL` และแอปมือถือ ถ้าคุณเปิดการติดตั้งเดียวกันจากที่อยู่อื่นด้วย เช่น ชื่อ Tailscale หรือ IP ใน LAN เบราว์เซอร์หรือแอป desktop จะได้ `403 INVALID_ORIGIN` ให้ใส่ที่อยู่นั้นใน `RAKAZO_EXTRA_AUTH_ORIGINS` คั่นด้วยจุลภาค:

```env
RAKAZO_EXTRA_AUTH_ORIGINS=https://rakazo.your-tailnet.ts.net,http://192.168.1.20:5173
```

แต่ละรายการต้องเป็น origin เปล่า (scheme, host และ port ถ้ามี ไม่มี path) `https://` ใช้ได้กับทุก host ส่วน `http://` ใช้ได้เฉพาะ loopback, `.local` และ IP ในเครือข่ายส่วนตัว (RFC 1918 และ 100.64.0.0/10 ของ Tailscale) ค่าอื่นจะถูกข้ามและเขียนคำเตือนใน log เชื่อถือเฉพาะ origin ที่คุณระบุ ค่าเริ่มต้นคือไม่มี `WEB_ORIGIN` ยังเป็นที่อยู่ที่ใช้ในลิงก์ passkey และ OAuth callback

## สวิตช์ฟีเจอร์

| ตัวแปร                     | ค่าเริ่มต้น          | ผล                                                                                                                 |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TICKET_BOARD_ENABLED`    | `false`          | เปิด ticket board ให้ทุกบัญชี ถ้าไม่ตั้ง แต่ละคนเปิดเองใน **ตั้งค่า (Settings) → Labs** ตั้งบน API และ worker                      |
| `USER_DEVICES_ENABLED`    | เปิด              | `false` ห้ามแอป desktop ที่ sign-in อยู่ให้ bot รันคำสั่งบนเครื่องของผู้ใช้เอง ตั้งบน API และ worker                               |
| `PI_SESSION_RECORDING`    | ปิด               | `true` บันทึก agent session เป็น JSONL ใต้ `DATA_DIR/pi-sessions` ไฟล์ไม่ได้เข้ารหัส อย่าใช้บนการติดตั้งที่ใช้ร่วมกันหรือ multi-tenant |
| `PRIVACY_POLICY_URL`      | นโยบายของ Rakazo | นโยบายความเป็นส่วนตัวที่ลิงก์จากประกาศการแชร์ข้อมูลกับ AI ตั้งบน API                                                            |
| `AUTH_RATE_LIMIT_ENABLED` | เปิดใน production | จำกัดอัตราการ sign-in และ route ที่เกี่ยวกับ credential อื่น `true` เปิดให้การติดตั้งที่รันโดยไม่มี `NODE_ENV=production` ตั้งบน API    |

## การเก็บประวัติแชท

Rakazo เก็บประวัติแชทไว้จนกว่าจะมีคนล้างแชทหรือลบ bot ถ้าต้องการลบอัตโนมัติ ให้ตั้ง `CHAT_HISTORY_RETENTION_DAYS` บน API และ worker เป็นจำนวนวันเต็ม:

```env
CHAT_HISTORY_RETENTION_DAYS=180
```

ประมาณชั่วโมงละครั้ง instance หนึ่งจะลบข้อความและ event ของแชทที่เก่ากว่านั้น เริ่มจากเก่าสุด แต่ละแชทจึงเก็บประวัติช่วงล่าสุดไว้ต่อเนื่อง แชทที่มี bot run กำลังทำงาน หรือมีคำถามหรือ takeover รอคำตอบ จะไม่ถูกแตะจนกว่าจะเสร็จ ข้อความที่ยังรอคิวหลัง run ก็เช่นกัน สรุปข้อความเก่าที่บันทึกไว้จะถูกลบไปพร้อมกัน ไม่ตั้งหรือเว้นว่างคือเก็บทุกอย่าง ค่าอื่นที่ไม่ใช่จำนวนเต็มตั้งแต่ 1 ถึง 36500 (รวม `0`) จะทำให้ worker และ API ที่รันงานเอง (`WAKEUP_DRIVER=memory`) ไม่ยอมเริ่ม การพิมพ์ผิดจึงไม่ทำให้ประวัติถูกเก็บไว้โดยไม่มีใครรู้ แชทที่เปิดอยู่ในแอปจะยังแสดงข้อความที่ลบแล้วจนกว่าจะโหลดใหม่

สิ่งที่ค่านี้ไม่ลบ: บันทึก run (prompt ของงานและ error) ไฟล์และภาพหน้าจอที่ bot เก็บไว้ memory ที่ bot บันทึก ข้อความที่ตัดมาอ้างอิงในคำตอบ ข้อความที่คัดลอกไปยังแอปแชทที่เชื่อมไว้ และ [audit log](../self-host-audit-log.md#retention) ซึ่งมีการเก็บรักษาของตัวเอง ประวัติที่ลบแล้วกู้คืนจากแอปไม่ได้ ส่วน [backup](./self-host-backups.md) เก็บไว้ตามระยะเก็บรักษาของตัวเอง

## role ของฐานข้อมูล

Rakazo ใช้ login ของ Postgres สองตัว:

- owner (`POSTGRES_USER` หรือ `DATABASE_MIGRATION_URL` นอก Compose) รัน migration และเป็นเจ้าของตาราง
- login ของแอป (`rakazo_app` กับ `POSTGRES_APP_PASSWORD` หรือ `DATABASE_URL`) ไม่ใช่ superuser ข้าม row-level security ไม่ได้ สร้าง object ไม่ได้ และอ่านเขียนได้เฉพาะตารางของแอป

`pnpm db:migrate` (ในคอนเทนเนอร์คือรูปแบบที่ build ไว้แล้ว `pnpm --filter @rakazo/api db:deploy` ซึ่งคอนเทนเนอร์ `migrate` แบบรันครั้งเดียวรันก่อน API เริ่ม) apply migration และ schema ของ job queue ในนามของ owner มีเฉพาะคอนเทนเนอร์นั้นที่ได้ login ของ owner โค้ดที่รันใน API หรือ worker จึงหา login ที่ข้าม row-level security ไม่ได้ จากนั้นจะสร้าง login ของแอปตามชื่อใน `DATABASE_URL` หรืออัปเดตรหัสผ่าน และ grant role `rakazo_app` ให้ ถ้า migration รันด้วย role ที่ไม่มี `CREATEROLE` เช่นบน managed Postgres บางเจ้า ให้สร้าง login เองแล้วรัน `GRANT rakazo_app TO <login>`

ข้อความ, event, thread, memory, artifact, secret, credential ของโมเดลและเสียง, skill, bot, run, task, routine, การเชื่อมต่อ, MCP server และการ sign-in, computer, board และ ticket, ตัวตนและ outbox ของ messaging, บทสนทนาภายนอก, steering message, usage, รายการ scratchpad และกฎการอนุมัติ มี row-level security คำขอที่ sign-in แต่ละรายการเห็นเฉพาะแถวของ Space ตัวเอง บวก credential ระดับบัญชีของผู้ใช้เอง query ที่ไม่ใส่ตัวกรอง Space จะไม่ได้อะไรจาก Space อื่น งานเบื้องหลังที่ทำแทน run, routine, computer, skill, thread หรือ cloud agent หนึ่งตัว รันในนาม Space และผู้ใช้ของแถวนั้น เครื่องมือของ agent จึงได้การป้องกันเดียวกัน security event เขียนและอ่านได้เฉพาะใน system scope ส่วน reconciler, การกวาดคิว, การส่งแชท และ webhook รันใน system scope ที่มีชื่อ (`runAsSystem` ใน `packages/db`) scope นั้นยังส่ง key ที่สร้างจากรหัสผ่านของ login แอป ซึ่ง `pnpm db:migrate` ลงทะเบียนไว้ SQL ที่รันให้ Space หนึ่งจึงสลับตัวเองเข้า system scope ไม่ได้ login ของแอปที่ไม่มีรหัสผ่านใน `DATABASE_URL` จะไม่มี key และ `pnpm db:migrate` จะเตือน ตารางของ job queue (`graphile_worker`) เก็บ metadata ของงาน ไม่ใช่เนื้อหาของ Space: graphile-worker เปิด row-level security ให้ตารางเหล่านี้ และ `pnpm db:migrate` เพิ่ม policy ที่ให้ login ของแอปเห็นทุกแถว

ถ้าตั้งแค่ `DATABASE_URL` migration และแอปจะใช้ login เดียวกัน ทุกอย่างยังทำงาน แต่ `pnpm db:migrate`, API และ worker จะเตือนว่าไม่ได้บังคับ row-level security วิธีแก้คือตั้ง `DATABASE_MIGRATION_URL` เป็น owner และ `DATABASE_URL` เป็น login ใหม่

รัน `pg_dump` ในนามของ owner เพราะ login ของแอปจะ dump ได้เฉพาะแถวที่มีสิทธิ์เห็น

## การเชื่อมต่อฐานข้อมูล

API มี pool การเชื่อมต่อ Postgres 4 ตัว และ worker มี 8 ตัว `DB_POOL_MAX` ตั้งทั้งสองเป็นค่าเดียวกัน จึงควรกำหนดตาม worker: Graphile Worker ต้องการอย่างน้อย 6 และ worker ยังถือการเชื่อมต่อแบบ listen อีกสามตัวกับการเชื่อมต่อสำหรับ leadership อีกหนึ่งตัว

`REALTIME_DATABASE_URL` ส่งการเชื่อมต่อ `LISTEN` ที่อยู่ได้นานและใช้ส่งการอัปเดตแบบสด ไปที่อยู่อื่นที่ไม่ใช่ `DATABASE_URL` เช่นการเชื่อมต่อตรงเมื่อ `DATABASE_URL` ผ่าน transaction pooler ค่าเริ่มต้นคือ `DATABASE_URL`

`GRAPHILE_WORKER_CONCURRENCY` (ค่าเริ่มต้น `4`) จำกัดจำนวนการส่งพร้อมกันจาก job queue แบบ interactive รุ่นเก่าระหว่าง rolling upgrade agent run ใหม่ dispatch จาก Postgres โดยตรงและไม่ใช้ slot เหล่านั้น

`RUN_DRAIN_ENABLED=true` ให้ worker ที่กำลังหยุดทำ turn ที่รันอยู่ให้จบได้นานสุดห้านาทีก่อนส่งคืน ถ้าไม่ตั้ง worker จะส่งคืนทันทีและ worker ตัวถัดไปจะเรียกโมเดลที่ค้างอยู่ซ้ำ `docker-compose.prod.yml` เปิดค่านี้ไว้ เปิดเฉพาะที่ที่ worker ที่กำลังหยุดถูกปล่อยไว้นานกว่านั้น เหมือนที่ `stop_grace_period` ของ Compose ทำ: worker ที่ถูก kill เร็วกว่านั้นจะทิ้ง run ไว้กลาง turn รอ lease หมดอายุ

## หน่วยความจำของ API และ worker

chat run ทำงานในคอนเทนเนอร์ API ที่รับข้อความ ส่วน routine และ run เบื้องหลังอื่นทำงานใน worker ทั้งสองจึงถือ agent turn ที่กำลังทำงาน ในไฟล์ production Compose `RAKAZO_API_MEMORY_LIMIT` และ `RAKAZO_WORKER_MEMORY_LIMIT` จำกัดหน่วยความจำ (ขนาดแบบ Compose เช่น `2g` หรือ `3072m` ค่าเริ่มต้น `2g` ทั้งคู่) เพิ่มค่าบนเครื่องที่ใหญ่ขึ้น ระหว่าง deploy จะรันคอนเทนเนอร์เก่าและใหม่ของแต่ละฝั่งพร้อมกันชั่วครู่ จึงต้องเผื่อพื้นที่ให้ทั้งสอง

## เพิ่มคอนเทนเนอร์ API และ worker

คอนเทนเนอร์ API และ worker แต่ละตัวใช้ประมาณหนึ่ง CPU core บนเครื่องที่มี core มากกว่านั้น `RAKAZO_API_REPLICAS` และ `RAKAZO_WORKER_REPLICAS` (ค่าเริ่มต้น `1` ทั้งคู่) รันได้หลายตัว ทั้งหมดแบ่งงานกันผ่าน Postgres และ Caddy กระจายคำขอไปยังคอนเทนเนอร์ API สคริปต์ deploy ใช้จำนวนใหม่ในการรันครั้งถัดไป โดยเริ่มคอนเทนเนอร์ใหม่ตามจำนวนนั้นก่อนหยุดตัวเก่า จึงต้องเผื่อหน่วยความจำไว้สองเท่าระหว่าง deploy ถ้ามีคอนเทนเนอร์ API มากกว่าหนึ่งตัว ให้ตั้ง webhook secret ให้ Telegram bot และ iMessage project ถ้าไม่มี API แต่ละตัวจะ poll ข้อความเดียวกัน

ระหว่าง deploy ยังต้องใช้การเชื่อมต่อฐานข้อมูลสองเท่าชั่วครู่ คอนเทนเนอร์ API และ worker แต่ละตัวถือการเชื่อมต่อได้ถึง `DB_POOL_MAX` บวกอีกไม่กี่ตัวสำหรับการอัปเดตแบบสด และ Postgres อนุญาตรวม 100 ตามค่าเริ่มต้น เมื่อสองเท่าของผลรวมจากทุกคอนเทนเนอร์ใกล้ค่านั้น ให้รัน `ALTER SYSTEM SET max_connections = 200;` ในนามของ owner (`POSTGRES_USER`) แล้ว restart Postgres ไม่อย่างนั้นระหว่าง deploy บางคำขอจะล้มเหลวด้วย "too many clients"

## หน่วยความจำของ Postgres

ไฟล์ production Compose กำหนดขนาด Postgres สำหรับเครื่อง 8 GB: `POSTGRES_MEMORY_LIMIT` จำกัดคอนเทนเนอร์ (ค่าเริ่มต้น `2560m`) `POSTGRES_SHARED_BUFFERS` ตั้ง cache (ค่าเริ่มต้น `1GB` ซึ่งนับรวมในขีดจำกัดนั้น) และ `POSTGRES_EFFECTIVE_CACHE_SIZE` บอก planner ว่าข้อมูลอยู่ใน cache ได้เท่าไร (ค่าเริ่มต้น `2GB`) บนเครื่องที่เล็กกว่า ให้ลดค่าเหล่านี้พร้อมกับขีดจำกัดของ API และ worker ด้านบน การเปลี่ยนค่าจะ restart Postgres

## ที่อยู่ที่ listen

API listen ที่ `API_HOST` (ค่าเริ่มต้น `127.0.0.1`) และ `API_PORT` (ค่าเริ่มต้น `3100`) ให้คง loopback ไว้ เว้นแต่คอนเทนเนอร์หรือ reverse proxy ที่เชื่อถือได้ต้องเข้าถึง ไฟล์ Compose ตั้งค่านี้ให้แล้ว stack แบบ published images เปิดเว็บแอปที่ `127.0.0.1:5173` และ API ที่ `127.0.0.1:3100` ตั้ง `RAKAZO_WEB_PORT` หรือ `RAKAZO_API_PORT` เพื่อใช้ port อื่นบนเครื่อง ถ้าต้องการเข้าถึงจาก LAN ให้ตั้ง `RAKAZO_WEB_BIND` ตาม[เชื่อมโทรศัพท์ในเครือข่ายเดียวกัน](../self-host-clients.md#connecting-a-phone-on-the-same-network)

## Proxy ขาออก

ถ้าจะส่ง traffic ขาออกของ API และ worker ผ่าน proxy ขององค์กร ให้ตั้ง `HTTP_PROXY`, `HTTPS_PROXY` และ `NO_PROXY` (ตัวพิมพ์เล็กหรือใหญ่ก็ได้) ใน `.env` ใส่ชื่อ service ของ stack เองใน `NO_PROXY` เพื่อให้ traffic ภายในไม่ผ่าน proxy:

```env
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,postgres,supervisor,api,worker,web
```

guarded fetch จะ tunnel ไปยังที่อยู่ที่ผ่านการตรวจว่าเป็นที่อยู่สาธารณะ proxy จึงไม่ได้ resolve ชื่อเอง proxy ที่แยกประเภท traffic ตามเป้าหมาย CONNECT จะทิ้งที่อยู่เปล่า สำหรับ HTTPS host ที่ proxy อนุญาตตามชื่อ ให้ตั้ง `RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS` เป็นรายการ host เหล่านั้นคั่นด้วยจุลภาค รายการแบบ `*.example.com` ตรงกับ subdomain เท่านั้น `*` เปล่าและ public suffix เช่น `*.com` จะถูกปฏิเสธ host ในรายการยังถูกตรวจกับ DNS ในเครื่องและ certificate และ HTTP ธรรมดายังผูกกับที่อยู่ที่ตรวจแล้ว ไม่ตั้งค่านี้ถ้าต้องการให้ทุก tunnel ใช้ที่อยู่ที่ตรวจแล้ว

```env
RAKAZO_PROXY_CONNECT_BY_HOSTNAME_HOSTS=api.example.com,*.downloads.example.com
```

สำหรับ mirror ของตัวติดตั้งและ image ดู[เครือข่ายที่จำกัด](../self-host-restricted-network.md)
