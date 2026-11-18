# โมเดล

เลือกโมเดลเริ่มต้นของ deployment เชื่อม local/OpenAI-compatible/Ollama และตั้ง voice ถ้าต้องการ

## โมเดลของ deployment

ใครที่ยังไม่เชื่อมโมเดลของตัวเอง จะใช้โมเดลของ deployment จาก `PI_DEFAULT_PROVIDER` และ `PI_DEFAULT_MODEL` โดยใส่ API key ของผู้ให้บริการ เช่น `OPENROUTER_API_KEY`

เลือกโมเดลที่รองรับภาพ เพื่อให้เครื่องมือ screenshot บน computer ยังใช้ได้

ใน `.env` ใส่ `OPENROUTER_API_KEY` หรือเชื่อมใน UI หลังสมัคร

## โมเดล local / Ollama

รายการ id และ endpoint ที่ API กับ worker เข้าถึงได้:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
# Optional: model ids on this endpoint that accept OpenAI-style reasoning_effort.
RAKAZO_LOCAL_REASONING_MODELS=qwen3:4b
```

จากคอนเทนเนอร์ให้ชี้ไปที่ LAN หรือ `host.docker.internal` (Docker Desktop) อย่าเปิดบริการที่ละเอียดอ่อนโดยไม่มีการยืนยันตัวตนบน loopback ขณะ bot ทำงาน ปล่อย `RAKAZO_LOCAL_MODELS` ว่างเพื่อปิด

ใน **ตั้งค่า (Settings) → Models** เลือก **Ollama Cloud** วาง API key จาก ollama.com แล้ว **Find models** ได้โดยไม่ต้องตั้ง env

ผู้ใช้เชื่อม OpenAI-compatible เองจาก **Connect a model** ใส่ base URL, model id และ key (ถ้ามี)

## ภาพและวิดีโอ (ถ้าเปิด)

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

ค่าเริ่มต้น `MEDIA_GENERATION_PROVIDER=disabled` อย่า commit key จริง

## เสียง (ไม่บังคับ)

voice เป็นทางเลือก ต้องใช้ key ของคุณเอง (ElevenLabs, OpenAI, Cartesia, Fish Audio ฯลฯ) หรือ macOS voices ถ้า API รันบน Mac

- `VOICE_SUMMARY_MIN_CHARS` — อ่านสรุปเมื่อข้อความยาวเกินค่านี้
- `FISH_TTS_MODEL`, `FISH_ASR_MODEL` — บน API และ worker
- `PHONE_CALLS_ENABLED=true` — เปิดโทรในแอป พร้อม `PHONE_CALL_COOLDOWN_MINUTES`, `PHONE_CALL_RING_SECONDS`

โหมดการอนุมัติ (Approvals) ตั้งใน **ตั้งค่า (Settings) → Approvals** และโมเดลตรวจใน **ตั้งค่า (Settings) → Models → Approval model**
