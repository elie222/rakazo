# โมเดล

[English](../self-host-models.md) | ไทย

เลือกโมเดลเริ่มต้นของ deployment เชื่อม server ในเครื่องหรือแบบ OpenAI-compatible และตั้งค่าการอนุมัติ การสร้างสื่อ และเสียง

## โมเดลของ deployment

ใครที่ยังไม่ได้เชื่อมโมเดลของตัวเองจะใช้โมเดลของ deployment `PI_DEFAULT_PROVIDER` เลือกผู้ให้บริการ และ `PI_DEFAULT_MODEL` เลือกโมเดล:

| `PI_DEFAULT_PROVIDER`  | Key                  | โมเดลเริ่มต้น                   |
| ---------------------- | -------------------- | ---------------------------- |
| `openrouter` (ค่าเริ่มต้น) | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |
| `anthropic`            | `ANTHROPIC_API_KEY`  | `claude-sonnet-5`            |
| `deepseek`             | `DEEPSEEK_API_KEY`   | `deepseek-flash`             |

เลือกโมเดลที่รองรับภาพ เพื่อให้เครื่องมือ computer ที่ใช้ภาพหน้าจอยังใช้ได้

ผู้ให้บริการที่ยืนยันตัวตนจากเครื่อง host ไม่ต้องใช้ key: สำหรับ Amazon Bedrock ที่ใช้ ECS task, IRSA หรือ EC2 instance role ให้เลือกใช้ด้วย `PI_DEFAULT_CREDENTIALS=host` แล้วตั้ง `PI_DEFAULT_PROVIDER=amazon-bedrock`, `PI_DEFAULT_MODEL` และ `AWS_REGION` ถ้าใช้ instance role ให้เปิด [restricted computer egress](../self-host-docker-computers.md#restricted-computer-egress) ไว้ เพื่อไม่ให้ bot computer อ่าน credentials ของ role จาก metadata endpoint ได้

Google Vertex ทำงานแบบเดียวกันด้วย `PI_DEFAULT_PROVIDER=google-vertex` โดยใช้ application default credentials ของเครื่อง (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) run ที่ใช้ credentials ของเครื่องจะเรียกเก็บเงินจากบัญชี cloud นั้น

บนเซิร์ฟเวอร์ที่คุณใช้คนเดียว โมเดลของ deployment ยังรันผ่าน [Claude Code CLI](#claude-code-cli) ที่ sign-in ไว้บนเครื่องได้ด้วย

ไฟล์ Compose ยังส่งตัวแปร key มาตรฐานของผู้ให้บริการที่ agent runtime อ่านเอง (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` และอื่น ๆ) ให้ API และ worker สำหรับโมเดลที่ไม่มี credential ที่บันทึกไว้

### ค่าเริ่มต้นสำหรับทุกคน

ผู้ดูแล (`RAKAZO_ADMIN_EMAILS`) ตั้งโมเดลของ deployment ใน **ตั้งค่า (Settings) → Models → Default for everyone** แทนได้: เลือกผู้ให้บริการที่เชื่อมด้วย API key วาง key แล้วเลือกโมเดล ค่านี้แทน `PI_DEFAULT_PROVIDER` และ `PI_DEFAULT_MODEL` สำหรับทุกคนที่ไม่มีโมเดลของตัวเอง ตั้งแต่ run ถัดไปโดยไม่ต้อง restart ส่วน **Default** จะกลับไปใช้ค่าจากสภาพแวดล้อม key ถูกเก็บแบบเข้ารหัส จะไม่แสดงอีก และถูกปิดบังใน output ของ run เหมือน key จากสภาพแวดล้อม ทุกการเปลี่ยนแปลงถูกบันทึกใน security audit log

`RAKAZO_MODEL_PROVIDER_ALLOWLIST` ใช้กับค่านี้เหมือนการเชื่อมต่อที่บัญชีใดก็ตามสร้าง: ผู้ให้บริการที่ไม่อยู่ในรายการจะไม่ถูกเสนอ และค่าที่บันทึกไว้จะหยุดใช้งานแล้วกลับไปใช้โมเดลจากสภาพแวดล้อม deployment ที่มี model credits จะรันบนการเชื่อมต่อของผู้ดูแลระบบเสมอ จึงไม่มีส่วนนี้ให้เลือกและค่าที่บันทึกไว้จะถูกข้าม การเรียกที่ผู้ดูแลระบบจ่าย เช่นตัวตรวจการอนุมัติของ deployment ยังใช้ key จากสภาพแวดล้อม แอป messaging ที่เปิดสมัครเสรีจะเปิดตอนเริ่มระบบเฉพาะเมื่อสภาพแวดล้อมตั้งค่าโมเดลไว้

`RAKAZO_LIVE_MODEL_CATALOG=off` (หรือ `false`, `0`, `no`) ปิดการตรวจ catalog แบบสดของผู้ให้บริการและ Codex ค่าเริ่มต้นคือเปิด และค่าที่ไม่รู้จักจะทำให้ API หยุดตอนเริ่ม

## การอนุมัติ

การอนุมัติมีสามโหมดใน **ตั้งค่า (Settings) → Approvals**: Never ask ข้ามการขออนุมัติปกติ, Auto ให้โมเดลอนุมัติผ่านการกระทำที่ตรงกับคำขอ และ Ask ถามก่อนทุกการเปลี่ยนแปลง space เริ่มต้นที่ Auto ซึ่งจะถามแบบ Ask จนกว่าจะมีโมเดลอนุมัติให้ใช้ แต่ละคนอนุญาตหรือบล็อกเครื่องมือและเว็บไซต์ทีละรายการได้ในทุกโหมด และ space ปรับการอนุมัติแยกจากบัญชีได้
ทุกโหมดยังบังคับใช้กฎบล็อกและการตรวจความปลอดภัย การซื้อต้องได้รับอนุมัติจากคนเสมอ run ที่ไม่มีคนดูแลและขออนุมัติไม่ได้จะปฏิเสธการซื้อ

ใน **ตั้งค่า (Settings) → Models → Approval model** ผู้ใช้แต่ละคนเลือกโมเดลจากการเชื่อมต่อที่มีอยู่ และเพิ่มตัวสำรองตามลำดับได้ แยกจากโมเดลหลัก การเชื่อมต่อส่วนตัวใช้ credentials ของตัวเอง การเรียกแบบ hosted ใช้กฎ credit ของ Rakazo เหมือนแชท ตัวสำรองจะถูกใช้เฉพาะเมื่อตัวตรวจล้มเหลว การสั่งให้ถามอย่างชัดเจน รวมถึงการตัดสินที่ไม่แน่ใจ ยังต้องให้คนตอบ

เมื่อไม่ได้เลือกโมเดลอนุมัติ ตัวตรวจของ deployment ยังเป็นค่าเริ่มต้น สำหรับ OpenRouter Jev ให้ตั้ง `RAKAZO_AUTO_REVIEW_PROVIDER=openrouter` และ `RAKAZO_AUTO_REVIEW_MODEL=typesafe/jev-1.14` ซึ่งใช้ `OPENROUTER_API_KEY` และ Decisions API ส่วน TypeSafe โดยตรงยังใช้ได้ผ่าน `RAKAZO_AUTO_REVIEW_PROVIDER=jev` และ `TYPESAFE_API_KEY` ระบบหลักทำงานได้โดยไม่ต้องใช้บริการ hosted ทั้งสอง

เมื่อใช้ TypeSafe `RAKAZO_AUTO_REVIEW_MODEL` มีค่าเริ่มต้นเป็น `jev-latest` และ `RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE` (0 ถึง 1) คือระดับความมั่นใจที่ต่ำกว่านั้น Auto จะถามคนแทน ถ้าไม่ตั้ง โมเดลตัดสินแต่ละตัวใช้เกณฑ์ที่ปรับเทียบไว้ของตัวเอง (`0.5` สำหรับ Jev) `RAKAZO_AUTO_REVIEW_TIMEOUT_MS` (200 ถึง 30000 ค่าเริ่มต้น `10000`) จำกัดเวลาของการตรวจแต่ละครั้ง

## โมเดลในเครื่อง

ถ้าจะใช้ server แบบ OpenAI-compatible ที่ผู้ดูแลระบบควบคุม เช่น Ollama, LM Studio, llama.cpp หรือ MLX ให้ระบุ id ของโมเดลและ endpoint ที่ทั้ง process ของ API และ worker เข้าถึงได้:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
# Optional: key for a server that requires one, sent as the bearer token.
RAKAZO_LOCAL_MODELS_API_KEY=
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
# Optional: model ids on this endpoint that accept OpenAI-style reasoning_effort.
RAKAZO_LOCAL_REASONING_MODELS=qwen3:4b
# Optional: prompt tokens per minute the server accepts (a rate-limited key or quota).
RAKAZO_LOCAL_TOKENS_PER_MINUTE=200000
# Optional: off when the server does not cache prompts.
RAKAZO_LOCAL_PROMPT_CACHE=off
```

ตั้ง `RAKAZO_LOCAL_MODELS_API_KEY` เมื่อ server ต้องใช้ key เช่น LiteLLM, vLLM ที่เริ่มด้วย `--api-key` หรือ gateway ขององค์กร ทุกคำขอไปยัง `RAKAZO_LOCAL_MODELS_URL` จะส่ง key นี้เป็น `Authorization: Bearer` ถ้าไม่ตั้ง คำขอจะส่งค่า placeholder `local` เหมือน key อื่นของ deployment ค่านี้อยู่บน API และ worker เท่านั้น และถูกปิดบังใน output ของ run ใช้ HTTPS เว้นแต่เครือข่ายเชื่อถือได้ ถ้าจะให้โมเดลในเครื่องเป็นโมเดลของ deployment ให้ตั้ง `PI_DEFAULT_PROVIDER=local`, `PI_DEFAULT_MODEL` เป็นหนึ่งใน `RAKAZO_LOCAL_MODELS` และ `PI_DEFAULT_CREDENTIALS=host`

โมเดลใน `RAKAZO_LOCAL_REASONING_MODELS` มีระดับ thinking ให้เลือก และส่งระดับที่เลือกเป็น `reasoning_effort` (ค่าเริ่มต้น `medium` และ `none` เมื่อปิด thinking) โมเดลในเครื่องตัวอื่นจะไม่ได้รับ field นี้

`RAKAZO_LOCAL_MAX_TOKENS` คือขีดจำกัด output ที่ส่งไปกับทุกคำขอถึงโมเดลในเครื่อง เว้นแต่การเชื่อมต่อตั้งค่า max-tokens ของตัวเอง ค่านี้ไม่เกินหนึ่งในสี่ของ `RAKAZO_LOCAL_CONTEXT_WINDOW` ส่วนที่เหลือจึงเป็นของ prompt ขีดจำกัดที่สูงขึ้นทำให้ prompt มีพื้นที่น้อยลง แชทยาวจึงถูกย่อเร็วขึ้น

server ที่อยู่หลัง key ที่จำกัดอัตรา (free tier หรือโควตา token ขององค์กร) มักตอบ `429` พร้อม `Retry-After` คงที่หนึ่งนาที การเรียกที่ถูกปฏิเสธแต่ละครั้งจึงเสียเวลาหนึ่งนาที ตั้ง `RAKAZO_LOCAL_TOKENS_PER_MINUTE` เป็นขีดจำกัด prompt token ของ server แล้ว Rakazo จะคุมจังหวะการเรียกไปยังผู้ให้บริการในเครื่องให้อยู่ใต้ค่านั้นด้วยหน้าต่างเลื่อนหนึ่งนาที และรอเท่าที่หน้าต่างต้องการเท่านั้น ค่าประมาณจะปรับเทียบกับ prompt token ที่ server รายงาน เผื่อไว้บ้างถ้า client อื่นใช้ key ร่วมกัน ถ้ายังเกิด `429` จะจัดการ `Retry-After` ตามปกติ ถ้าไม่ตั้ง การเรียกจะส่งทันทีที่พร้อม เหมือนขีดจำกัด token อื่น ค่าที่ไม่ใช่จำนวนเต็มบวกจะถูกปฏิเสธเมื่อตั้งค่าผู้ให้บริการในเครื่อง

Rakazo คงข้อความก่อนหน้าของ run ไว้ไม่เปลี่ยนระหว่างการเรียก เพื่อให้ prompt cache ของ server ยังใช้ได้ และตัด page state เก่าออกเฉพาะเมื่อประหยัดได้มากกว่าที่ cache ประหยัด server ที่ไม่มี prompt cache (gateway แบบ hosted หลายตัวและ endpoint แบบ confidential compute ไม่รายงาน cached token) ไม่ได้ประโยชน์จากส่วนนี้ และ page snapshot เก่าจะถูกส่งซ้ำทุกการเรียก ตั้ง `RAKAZO_LOCAL_PROMPT_CACHE=off` เพื่อระบุเรื่องนี้: page state ที่ค้างจะถูกตัดออกเมื่อสะสมถึงประมาณ 3,000 token ถ้าไม่ตั้ง พฤติกรรมจะเหมือนเดิม

ค่า loopback เริ่มต้นเหมาะเมื่อรัน Rakazo จาก source checkout ถ้ารันจากคอนเทนเนอร์ ให้ใช้ที่อยู่ LAN แบบ RFC1918 ที่คงที่ (ไม่ใช่แค่ DNS ของ service ใน Compose) บน Docker Desktop ใช้ `host.docker.internal` ได้เช่นกัน
บน Docker Desktop shell ของ bot computer มักเข้าถึงบริการที่ bind กับ `127.0.0.1` ของเครื่อง host ผ่าน hostname เดียวกันได้ อย่ารันบริการที่ละเอียดอ่อนและไม่มีการยืนยันตัวตนบน loopback ขณะ bot ทำงาน หรือใช้ firewall บล็อกเส้นทางนั้น Linux ไม่มี `host.docker.internal` แบบเดียวกันเป็นค่าเริ่มต้น
ตั้งค่าเฉพาะ endpoint ที่คุณควบคุม: prompt, ไฟล์แนบ และผลลัพธ์ของเครื่องมือที่ส่งให้โมเดลนั้นจะออกจาก Rakazo ผ่าน URL นี้ ปล่อย `RAKAZO_LOCAL_MODELS` ว่างเพื่อปิดผู้ให้บริการนี้

## Claude Code CLI

ถ้ามี Claude subscription เซิร์ฟเวอร์ที่คุณใช้คนเดียวสามารถรันโมเดลของ deployment ผ่าน Claude Code CLI ทางการ ที่ sign-in ด้วยบัญชีของคุณเองได้ ในแต่ละ turn ของโมเดล Rakazo จะเริ่มคำสั่ง `claude` ที่ติดตั้งบนเซิร์ฟเวอร์และอ่านคำตอบ Rakazo ไม่อ่าน ไม่เก็บ ไม่ส่งต่อ และไม่ refresh การ sign-in Claude ของคุณ และทุกคำขอถึง Anthropic เป็นของ CLI เอง Rakazo ดูแลบทสนทนา เครื่องมือ memory และการอนุมัติ: CLI แค่ตอบในฐานะโมเดล โดยปิดเครื่องมือ การตั้งค่า ไฟล์ project และ session ที่บันทึกไว้ของตัวเอง

สิ่งที่ต้องมี:

- API และ worker รันจาก source checkout บนเครื่องเดียวกับ CLI ในนามผู้ใช้ OS คนเดียวกัน Docker image ทางการและ local stack ของแอป desktop ไม่มี Claude Code และไม่รองรับการเพิ่มเข้าไป
- Claude Code 2.1.280 ขึ้นไปใน `PATH` ของผู้ใช้นั้น และ sign-in ครั้งหนึ่งใน terminal ในนามผู้ใช้นั้นด้วย `claude auth login` บนเซิร์ฟเวอร์ที่ไม่มีเบราว์เซอร์ CLI ใช้ token ที่ `claude setup-token` สร้างแทนได้: ตั้งเป็น `CLAUDE_CODE_OAUTH_TOKEN` พร้อม `RAKAZO_CLAUDE_CODE_SETUP_TOKEN=1` ในสภาพแวดล้อมของ API และ worker ไม่ว่าแบบไหนก็ไม่มีการ sign-in Claude ภายใน Rakazo
- มีบัญชีเดียวบนเซิร์ฟเวอร์ การ sign-in Claude เป็นของคนคนเดียว Rakazo จึงปฏิเสธ run ของ Claude Code เมื่อเซิร์ฟเวอร์มีมากกว่าหนึ่งบัญชี (ไม่นับคนที่แค่ส่งข้อความหา bot จากแอปแชท) หรือเรียกเก็บเงินค่าใช้โมเดล

```env
PI_DEFAULT_PROVIDER=claude-code
PI_DEFAULT_CREDENTIALS=host
PI_DEFAULT_MODEL=claude-sonnet-5
```

ใช้ model id เต็มที่ CLI รับใน `claude --model` เพื่อให้ Rakazo รู้ขีดจำกัด context และ output ของโมเดล การใช้งานนับรวมในแผน Claude ของคุณและขีดจำกัดของแผน ซึ่งออกแบบมาสำหรับการใช้งานส่วนตัวทั่วไป Rakazo ไม่แสดงค่าใช้จ่ายของ run เหล่านี้ และเมื่อถึงขีดจำกัดของแผน run จะล้มเหลวด้วย error เรื่อง rate limit จนกว่าจะรีเซ็ต การใช้ Claude Code อยู่ภายใต้ข้อกำหนดของ Anthropic ดู [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

CLI รันในโฟลเดอร์ชั่วคราวส่วนตัวที่ว่างเปล่า พร้อมสภาพแวดล้อมที่อนุญาตเฉพาะบางค่า API key และ secret อื่นของเซิร์ฟเวอร์ รวมถึง `ANTHROPIC_API_KEY` จะไม่ถูกส่งให้ CLI จึงใช้การ sign-in ของตัวเองเสมอ `RAKAZO_CLAUDE_CODE_SETUP_TOKEN=1` เพิ่มเฉพาะ `CLAUDE_CODE_OAUTH_TOKEN` ซึ่ง CLI อ่าน แต่ Rakazo ไม่อ่าน เฉพาะโมเดลของ deployment ที่รันบน Claude Code ได้ และไม่มีให้เลือกเป็นการเชื่อมต่อใน **ตั้งค่า (Settings) → Models**

## Ollama Cloud

ใน **ตั้งค่า (Settings) → Models** เลือก **Ollama Cloud** วาง API key จาก ollama.com แล้วเลือกโมเดลจากรายการที่โหลดมา วิธีนี้ใช้การเชื่อมต่อแบบ OpenAI-compatible โดยไม่ต้องตั้งค่าสภาพแวดล้อม และยังใช้ได้เมื่อ `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` ถ้า `RAKAZO_MODEL_PROVIDER_ALLOWLIST` ไม่มี `ollama-cloud` preset นี้จะหายไป และเมื่อ `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` ข้อยกเว้นของ host ก็หายไปด้วย ดู[จำกัดผู้ให้บริการโมเดล](#จำกัดผู้ให้บริการโมเดล)

## การเชื่อมต่อแบบ OpenAI-compatible

ผู้ใช้แต่ละคนยังเชื่อม endpoint แบบ OpenAI-compatible ของตัวเองได้จาก **Connect a model** หรือ **ตั้งค่า (Settings) → Models** บนเว็บและมือถือ เลือก **OpenAI-compatible** ใส่ base URL ของ server (เช่น `http://127.0.0.1:8000/v1`) model id ที่ตรงทุกตัวอักษร และ API key ถ้ามี
เพิ่ม request header ได้ใน **Advanced** ค่าจะถูกเก็บแบบเข้ารหัส และภายหลังจะแสดงเฉพาะชื่อ
host สาธารณะและ hostname ทั่วไปต้องใช้ HTTPS เมื่อรับ API key หรือ header ที่กำหนดเอง และต้อง resolve เป็นที่อยู่สาธารณะเท่านั้น ตั้ง `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` บน API และ worker เพื่อบล็อก host เหล่านี้
IP ส่วนตัวแบบตัวเลข loopback ชื่อ mDNS `.local` และ `host.docker.internal` ไม่อยู่ในเงื่อนไขนี้ แต่จะถูกปฏิเสธ เว้นแต่ตั้ง `MCP_ALLOW_PRIVATE_ENDPOINT=true` บน API และ worker ซึ่งอนุญาตให้ทุกผู้ใช้ การตรวจนี้ทำตอนบันทึก ตอนค้นหาโมเดล และทุก run
ในการติดตั้งด้วย Docker images และแอป desktop การเชื่อมต่อไปที่ `localhost` หรือ `127.0.0.1` จะไปถึงเครื่องที่รัน Docker (ผ่าน `host.docker.internal`) บน Linux server ของโมเดลต้อง listen บนที่อยู่ที่ Docker bridge เข้าถึงได้ ไม่ใช่แค่ `127.0.0.1`
สำหรับ endpoint ที่ self-host และ hostname resolve เป็น IP ส่วนตัว ให้ตั้ง `RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS=models.example.test,other.example.test` ในสภาพแวดล้อมของ deployment ทั้ง API และ worker แล้วสร้างคอนเทนเนอร์เหล่านั้นใหม่ แต่ละรายการคือ hostname ที่ตรงทุกตัวอักษร (ไม่สนตัวพิมพ์เล็กใหญ่ มีจุดท้ายได้) ไม่ใช่ URL, suffix หรือ wildcard ชื่อ mDNS `.local` ตามธรรมเนียมเป็นชื่อเครื่องใน LAN จึงไม่ต้องเพิ่มในรายการ mDNS resolve ในที่ที่ API และ worker รัน: ใช้ได้กับการติดตั้งแบบ native และเครื่องที่รองรับ mDNS แต่มักใช้ไม่ได้กับ DNS ของ bridge ในคอนเทนเนอร์ host เหล่านี้ไม่สนใจ `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC` ทุกคำตอบของ DNS ต้องเป็นที่อยู่ส่วนตัว และปลายทาง metadata กับ link-local ยังถูกบล็อก กฎนี้ใช้กับการค้นหาโมเดลและคำขอถึงโมเดล
HTTPS ยังตรวจ certificate ของ hostname เหมือน endpoint ที่เป็น IP ส่วนตัว hostname ที่เชื่อถือยังอนุญาต HTTP พร้อม API key ได้ ใช้ HTTPS เว้นแต่เครือข่ายเชื่อถือได้ อนุญาตเฉพาะ host ที่คุณควบคุม endpoint ส่วนตัวต้องตั้ง `MCP_ALLOW_PRIVATE_ENDPOINT=true` สำหรับ deployment ไม่มีบัญชีใดในแอปข้ามนโยบายนี้ได้
ถ้าโมเดลของ endpoint นั้นรับภาพได้ ให้เปิด **Supports images** ใน **Advanced** ตอนเชื่อมต่อ เพื่อให้ไฟล์แนบและเครื่องมือ computer ที่ใช้ภาพหน้าจอยังใช้ได้ การเชื่อมต่อที่มีอยู่แล้วปิดไว้เป็นค่าเริ่มต้น สำหรับ endpoint ที่จัดการจากส่วนกลาง ค่าสำรองระดับ deployment ยังคงเป็น `RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`

## จำกัดผู้ให้บริการโมเดล

ตั้ง `RAKAZO_MODEL_PROVIDER_ALLOWLIST=provider1,provider2` ในสภาพแวดล้อมของ deployment ทั้ง API และ worker แล้วสร้างคอนเทนเนอร์เหล่านั้นใหม่ เพื่อจำกัดผู้ให้บริการโมเดลที่ผู้ใช้เชื่อมได้ แต่ละรายการคือ provider id ใน model registry (เช่น `openrouter`, `anthropic` และ `openai-compatible` สำหรับ endpoint แบบ OpenAI-compatible) รายการนี้ใช้กับ model catalog: ผู้ให้บริการที่ไม่อยู่ในรายการจะไม่ถูกเสนอ key ของผู้ให้บริการนั้นถูกปฏิเสธตอนบันทึกและตอน import เปลี่ยน bot ไปใช้ไม่ได้ และ run จะล้มเหลวพร้อม error ที่ชัดเจน รายการที่ไม่ตั้งหรือว่างหมายถึงทุกผู้ให้บริการ เหมือนไม่มีค่านี้ทุกประการ

preset แบบ OpenAI-compatible ที่เป็น hosted ได้แก่ Ollama Cloud (`ollama-cloud`), Concentrate AI (`concentrate`) และ DeepInfra (`deepinfra`) เลือกใน **ตั้งค่า (Settings) → Models** ใส่ API key แล้วเลือกโมเดล Rakazo โหลดรายการให้อัตโนมัติ HTTPS host ของ preset เหล่านี้ยังใช้ได้เมื่อ `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0`
ถ้าตั้ง allowlist ของผู้ให้บริการ ให้ใส่ `openai-compatible` และ id ของ preset ที่ต้องการเก็บไว้ preset ที่ไม่ได้ใส่ id จะถูกซ่อนและเสียข้อยกเว้นของ host

## Thinking

สำหรับ server ที่รับ `reasoning_effort` มาตรฐาน ให้เปิด **Supports thinking** ใน **Advanced** ตอนเชื่อมต่อ ค่านี้บันทึกไว้กับการเชื่อมต่อ (ไม่ต้องใช้ env var หรือ restart) การเชื่อมต่อที่มีอยู่แล้วปิดไว้เป็นค่าเริ่มต้น โมเดลในเครื่องของ deployment เลือกใช้ผ่าน `RAKAZO_LOCAL_REASONING_MODELS` เชื่อมใหม่ผ่าน **ตั้งค่า (Settings) → Models** เฉพาะเมื่อต้องการย้ายไปเป็นการเชื่อมต่อส่วนตัว

การเชื่อมต่อที่เปิดไว้ใช้ thinking ระดับ medium เป็นค่าเริ่มต้น เว็บและ desktop แสดง **Thinking** ในการตั้งค่าขั้นสูงของ bot ส่วนมือถือใช้นโยบายเดียวกันจาก backend Rakazo ส่ง `reasoning_effort` มาตรฐาน (`minimal`, `low`, `medium`, `high` หรือ `none` เมื่อปิด) server รับผิดชอบการแปลงเฉพาะโมเดลเอง ปิด **Supports thinking** ไว้ถ้า server ไม่รองรับ effort มาตรฐาน ขีดจำกัด token ที่มีอยู่ยังใช้อยู่ effort ไม่ใช่งบ reasoning token แยกต่างหาก

## ความสามารถของ prompt cache

API ของการเชื่อมต่อโมเดลรับ `cacheCapabilities` ซึ่งมี `scope`, `retentionMs`, `minimumTokens` และ `retentionMode` ระบุ `retentionMs` ที่เป็นบวกเฉพาะเมื่อ endpoint รองรับการใช้ prefix ซ้ำภายในช่วงเวลานั้น สำหรับการเชื่อมต่อเหล่านี้ที่มีเครื่องมือดึงประวัติที่ใช้ได้ runtime จะใช้ context ที่คำนึงถึง cache อัตโนมัติ: ประวัติล่าสุดถูกจำกัดในคำขอแรกที่ cache ยังเย็น และคำขอถัดไปจะคง prefix ที่เลือกไว้ขณะที่ cache น่าจะยังอุ่นและพอดีกับงบ context การเชื่อมต่อที่ไม่รู้ระยะเก็บ หรือมี `retentionMode: "none"` ใช้นโยบายการดึงข้อมูลแบบเริ่มต้น กลยุทธ์ context ที่ executor ระบุไว้ชัดเจนยังมีลำดับความสำคัญสูงกว่า ผู้เรียกที่ไม่มีเครื่องมือดึงประวัติที่ใช้ได้จะยังใส่ประวัติเดิมให้พอดีกับงบ context ของโมเดล แทนที่จะแทนด้วย snapshot

ความอุ่นของ cache เป็นเพียงคำแนะนำ การเปลี่ยนคำสั่งหรือเครื่องมือ แรงกดดันของ context การ evict ของ worker หรือการ restart process อาจทำให้ต้องประมวลผล prompt ใหม่ ค่าเหล่านี้ไม่ได้สร้าง KV snapshot ฝั่ง backend หรือทำให้โมเดลโหลดค้างไว้ inference server รับผิดชอบการเก็บรักษาและการสลับบทสนทนาเอง

## บริการข้อมูลแบบเสียเงิน

bot ค้นข้อมูลแบบเสียเงินได้ (สถานที่บนแผนที่ ผลการค้นหา อีเมลที่ทำงาน โปรไฟล์บุคคลและบริษัท โพสต์โซเชียล ข้อมูล SEO) ผ่านบัญชี deployment เดียว ปิดเป็นค่าเริ่มต้น ตั้งค่าบน worker (และ API สำหรับการรันแบบ inline):

```dotenv
PAID_SERVICES_PROVIDER=treg
PAID_SERVICES_API_KEY=replace-with-org-scoped-token
```

`PAID_SERVICES_PROVIDER` รับ `disabled` (ค่าเริ่มต้น), `treg` หรือ `fake` (สำหรับทดสอบออฟไลน์เท่านั้น) `PAID_SERVICES_BASE_URL` ชี้ไปยัง Treg ที่ self-host แทน `https://treg.to` ใช้ token ระดับองค์กร และเติมเงินในบัญชีไว้หรือเปิดเติมอัตโนมัติ: ถ้ายอดเงินหมด ทุกการเรียกจะล้มเหลว

bot ได้ `service_search` และ `service_call` ในทุก run `service_call` ทำตามโหมดการอนุมัติของ bot เหมือนการกระทำอื่น มีเฉพาะการค้นข้อมูลแบบอ่านอย่างเดียว: การกระทำกับบัญชี งานสร้างเนื้อหา และบริการที่ต้องใช้การเชื่อมต่อของบัญชีเองจะไม่ถูกรวม แต่ละการเรียกมีเพดานค่าใช้จ่ายที่ bot ตั้งและแสดงบนการ์ดขออนุมัติ (ไม่เกิน $2) ซึ่งผู้ให้บริการบังคับก่อนเรียกเก็บเงิน เมื่อเปิด model credits การเรียกจะกันเพดานนั้นจาก credit ขององค์กรก่อน แล้วชำระตามที่ผู้ให้บริการเรียกเก็บบวก 20% ไม่เกินเพดาน การเรียกที่ผู้ให้บริการไม่เรียกเก็บเงินจะฟรี การเรียกที่อาจรันไปแล้วแต่ไม่ได้คำตอบจะคงการกันเงินไว้ให้ credit reconciler ตรวจ ทุกการเรียกแสดงใน Usage ภายใต้ผู้ให้บริการ `services`

## การสร้างภาพและวิดีโอ

เครื่องมือสื่อของ bot ปิดเป็นค่าเริ่มต้น ตั้งค่า worker (และ API สำหรับการรันแบบ inline) ด้วยผู้ให้บริการและการเชื่อมต่อ HTTP ทั่วไปของมัน:

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

สำหรับภาพอย่างเดียว `openai` ใช้ Images API (`POST /images/generations`) แทน:

```dotenv
MEDIA_GENERATION_PROVIDER=openai
MEDIA_GENERATION_BASE_URL=https://api.openai.com/v1
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=gpt-image-1
```

`openrouter` สร้างภาพผ่าน Images API ของ OpenRouter (`POST /images`) และวิดีโอสี่วินาทีผ่าน video jobs API (`POST /videos`) ตั้งโมเดลใดโมเดลหนึ่งหรือทั้งสอง:

```dotenv
MEDIA_GENERATION_PROVIDER=openrouter
MEDIA_GENERATION_BASE_URL=https://openrouter.ai/api/v1
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=openai/gpt-image-1-mini
MEDIA_GENERATION_VIDEO_MODEL=google/veo-3.1-fast
```

โมเดลวิดีโอต้องรับความยาวสี่วินาทีได้

`MEDIA_GENERATION_PROVIDER` รับ `disabled` (ค่าเริ่มต้น), `fal`, `openai`, `openrouter` หรือ `fake` (สำหรับทดสอบออฟไลน์เท่านั้น) base URL เป็นทางเลือก ค่าเริ่มต้นคือ URL ของผู้ให้บริการด้านบน ตั้ง field โมเดลภาพหรือวิดีโอเฉพาะความสามารถที่ต้องการเปิด `openai` รับเฉพาะโมเดลภาพ server ที่เข้ากันได้ใช้ field การเชื่อมต่อเดียวกันได้ โมเดลต้องรองรับ fal queue API และรูปแบบ input/output ของ Flux/Wan หรือ Images API ที่ตอบข้อมูลภาพแบบ base64 (`b64_json`) credentials อยู่บนเซิร์ฟเวอร์ ตั้งค่าเหล่านี้ในการตั้งค่า secret ของ deployment และอย่า commit credentials จริง

bot ใช้ `generate_image` เพื่อแนบภาพหนึ่งภาพ (PNG, JPEG หรือ WebP) หรือ `generate_video` เพื่อส่งงานวิดีโอ MP4 สี่วินาที เครื่องมือวิดีโอคืน job ID และสถานะ queued/running worker ตรวจงานต่อในเบื้องหลัง รวมถึงหลัง restart และโพสต์วิดีโอที่เสร็จแล้วไปยังแชทที่ขอหนึ่งครั้ง จากนั้น bot ได้ turn เพื่อติดตามผล วิดีโอที่ล้มเหลวหรือยังไม่เสร็จหลังหนึ่งชั่วโมงจะถูกทำเครื่องหมายว่าล้มเหลว และ bot ได้ turn เพื่อแจ้ง bot ยังเรียกเครื่องมืออีกครั้งพร้อม `jobId` เพื่อดูความคืบหน้าได้ ใช้สวิตช์เครื่องมือราย bot และกฎการอนุมัติการกระทำที่มีอยู่เพื่อคุมการเข้าถึง เครื่องมือทั้งสองต้องขออนุมัติเป็นค่าเริ่มต้น run ของ ticket board ไม่มีเครื่องมือสื่อที่ใช้เฉพาะแชทเหล่านี้ เพื่อให้งาน ticket อยู่บน board

แต่ละ run ส่งงานได้ไม่เกินสองครั้ง (รวมที่ล้มเหลว) การส่งงานไม่ลองใหม่อัตโนมัติ: response ที่หายไปอาจหมายความว่าผู้ให้บริการรับและเรียกเก็บเงินคำขอแล้ว error ของผู้ให้บริการไม่รวม response body จากปลายทาง ตั้งงบประมาณและ rate limit ของบัญชีกับผู้ให้บริการของคุณ เพดานต่อ run ไม่ใช่งบประมาณเป็นเงิน response 429 จากผู้ให้บริการจะคืนกลับโดยไม่ลองใหม่อัตโนมัติ ผลลัพธ์ต้องไม่เกินทั้งเพดานสื่อ 10 MiB และขีดจำกัดไฟล์แนบที่ตั้งไว้ ผลลัพธ์ที่ใหญ่กว่าจะถูกปฏิเสธ

ภาพใช้การแสดงผลในแชทแบบ inline ที่มีอยู่ ไฟล์ MP4 ดูตัวอย่างได้ด้วยตัวควบคุมวิดีโอแบบ native บนเว็บและ Electron และเปิดหรือดาวน์โหลดผ่านขั้นตอนไฟล์แบบ native ที่มีอยู่บนมือถือ ไม่ต้องมี player หรือหน้าตั้งค่าใหม่บนมือถือ

## เสียง

### เสียงของ macOS

เมื่อ API รันบน macOS การตั้งค่าเสียงจะมี **macOS** ให้เลือกด้วย ซึ่งไม่ต้องใช้ key API สร้างเสียงของแต่ละคำตอบด้วย `/usr/bin/say` ในตัวเป็นคลิปเสียง จึงเล่นบนอุปกรณ์ของผู้ฟังและหยุดได้เหมือนเสียงอื่น เครื่อง Docker และ Linux จะไม่แสดงตัวเลือกนี้

### สรุปแบบพูด

ปิดเป็นค่าเริ่มต้น ตั้ง `VOICE_SUMMARY_MIN_CHARS` (เช่น `600`) เพื่อให้เสียงอ่านคำตอบของ bot ที่ยาวเกินจำนวนตัวอักษรนั้นเป็นสรุปสั้น ๆ ที่เขียนโดยโมเดลของ bot นั้นเอง แต่ละสรุปเป็นการเรียกโมเดลเพิ่มที่คิดค่าใช้จ่ายกับ bot แชทยังเก็บคำตอบเต็ม และถ้าการสรุปล้มเหลวจะอ่านคำตอบเต็ม

### Fish Audio

`FISH_TTS_MODEL` ตั้งโมเดลเสียงพูดของ Fish Audio สำหรับการเชื่อมต่อที่ไม่ได้เลือกโมเดล (ค่าเริ่มต้น `s2.1-pro`) และ `FISH_ASR_MODEL` ตั้งโมเดลถอดเสียง (ค่าเริ่มต้น `transcribe-1-pro`) ตั้งบน API และ worker

### การโทร

bot โทรหาผู้ใช้ในแอปได้ และผู้ใช้กดค้างเพื่อพูดได้ เมื่อตั้ง `PHONE_CALLS_ENABLED=true` บน API และ worker `PHONE_CALL_COOLDOWN_MINUTES` (ค่าเริ่มต้น `2`) คือเวลาขั้นต่ำระหว่างการโทรของ bot หาคนเดิม และ `PHONE_CALL_RING_SECONDS` (ค่าเริ่มต้น `45`) คือเวลาที่สายที่ไม่มีคนรับจะดัง

สำหรับเสียงเรียกเข้าแบบ native บนมือถือและการตั้งค่า APNs VoIP ที่เป็นทางเลือก ดู [Mobile incoming calls](../self-host-clients.md#mobile-incoming-calls)
