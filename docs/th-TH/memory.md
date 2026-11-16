# ความจำ

bot จดสิ่งสำคัญข้ามบทสนทนา คุณอ่าน แก้ ลบ หรือดาวน์โหลดได้

## ความจำของ bot

bot เขียนโน้ตลง `MEMORY.md` สูงสุดประมาณ 4 KB หนึ่งข้อความต่อบรรทัด พูดว่า "จำไว้ว่า..." ก็ได้

ดูได้โดยคลิกชื่อ bot → **ความจำ (Memory)** บนมือถือ โน้ตอยู่ในการตั้งค่าแชทของ bot

## ความจำร่วม (Shared memory)

ข้อมูลที่ทุก bot ใน space ควรรู้ (ชื่อของคุณ บริษัท และรูปแบบรายงาน) อยู่ใน **ตั้งค่า (Settings) → Memory**

## memory provider (ทางเลือก)

**ตั้งค่า (Settings) → Memory** → **Connect memory provider**: Supermemory, Serenity, Honcho ฯลฯ

**Default scope**:

- **Isolated** — แต่ละ bot จำเฉพาะที่ตัวเองบันทึก (ค่าเริ่มต้น)
- **Shared** — bot ใน space ใช้ชุดความจำร่วมกัน

ตั้ง **Memory scope** ต่อ bot ใน **ขั้นสูง (Advanced)** ได้

## งานค้าง (Open work)

แยกจาก memory — รายการสั้นที่ bot ยังไม่จบ อยู่ในการตั้งค่า bot

ความจำไม่ข้าม space — bot ใน space หนึ่งอ่านโน้ตของอีก space ไม่ได้
