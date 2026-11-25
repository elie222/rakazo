# แก้ปัญหา

[English](../troubleshooting.md) | ไทย

เมื่อข้อผิดพลาดมีลิงก์ **Troubleshoot** ให้เปิดลิงก์นั้นเพื่อดูสาเหตุและขั้นตอนแก้ไข
ถ้าคุณไม่ได้ดูแลเซิร์ฟเวอร์ ให้ส่งคู่มือนี้ให้ผู้ดูแลเซิร์ฟเวอร์

## ให้ผู้ช่วย AI ช่วย

คุณให้หน้านี้ รหัสข้อผิดพลาด และเวอร์ชันแอปกับผู้ช่วย AI เพื่อช่วยนำคำแนะนำไปใช้กับการตั้งค่าของคุณได้
คัดลอก prompt นี้แล้วเติมช่องว่าง:

```text
Help me troubleshoot Rakazo using this guide:
https://rakazo.com/docs/troubleshooting/

Error code: <code from the relevant section below>
App version: <version>
Installation method: <published Docker images, source, or other>
What I was doing: <action that failed>

Read the relevant section before recommending changes. Ask for any missing details.
Explain what each change does and how to verify it. Do not request passwords, API keys,
access tokens, cookies, or an entire .env file. Ask only for the specific non-secret
settings needed. Do not disable authentication or URL validation to bypass the error.
```

ตรวจคำสั่งที่เสนอก่อนรัน ถ้าคู่มือนี้แก้ข้อผิดพลาดไม่ได้
[รายงาน bug](https://github.com/elie222/rakazo/issues) พร้อมรหัสข้อผิดพลาด เวอร์ชัน
วิธีติดตั้ง และขั้นตอนทำซ้ำ ลบ secret และข้อมูลส่วนตัวออกก่อน

## MCP OAuth redirect ไม่ตรง

**รหัส:** `MCP_OAUTH_REDIRECT_MISMATCH`

**ข้อความ:** “The sign-in address does not match this server's configuration.” เวอร์ชันเก่า
แสดง “MCP OAuth redirect URI is not allowed”

แอปใช้ที่อยู่ในเบราว์เซอร์ของคุณสร้าง callback สำหรับการลงชื่อเข้าใช้ API ยอมรับเฉพาะ callback
ที่ตั้งผ่าน `WEB_ORIGIN` ข้อผิดพลาดนี้หมายความว่า URL ทั้งสองไม่ตรงกัน
และเกิดขึ้นก่อนที่ขั้นตอนลงชื่อเข้าใช้ของบริการภายนอกจะเริ่ม

1. คัดลอก origin จากแถบที่อยู่ของเบราว์เซอร์: scheme, hostname และ port โดยไม่มี path
   เช่น `https://app.example.com` หรือ `http://127.0.0.1:5173`
2. ตรวจ `WEB_ORIGIN` ที่ API ใช้งานจริง ถ้าเป็นที่อยู่สาธารณะที่ตั้งใจไว้ ให้เปิด Rakazo
   ที่ที่อยู่นั้นแทน `localhost` กับ `127.0.0.1` ถือว่าต่างกันสำหรับการตรวจนี้ เช่นเดียวกับ
   HTTP กับ HTTPS หรือพอร์ตที่ต่างกัน
3. ถ้าตั้งค่าผิด ให้ตั้ง `WEB_ORIGIN` เป็นที่อยู่ที่คนใช้จริง
   สำหรับ deployment สาธารณะ ใช้ origin แบบ HTTPS และให้ `BETTER_AUTH_URL` กับ `API_URL` สอดคล้องกัน
   ตามที่อธิบายใน[คู่มือ self-host](./self-host.md) สำหรับการพัฒนาจาก source ในเครื่อง
   `API_URL` ยังชี้ไปที่ API listener ที่แยกไว้ได้
4. รีสตาร์ต API ด้วย environment ที่อัปเดตแล้ว ถ้าใช้ Docker Compose ให้สร้าง API service ใหม่
   (recreate) โดยใช้ไฟล์ Compose และไฟล์ environment ชุดเดียวกับที่ติดตั้ง
   การรีสตาร์ตคอนเทนเนอร์เดิมอย่างเดียวไม่อัปเดต environment
5. เปิดที่อยู่ที่เลือกแล้วเชื่อม integration ใหม่ การลงชื่อเข้าใช้ควรผ่านข้อผิดพลาดนี้ไปได้

ถ้าคุณลงทะเบียน OAuth client เอง redirect URI ที่อนุญาตต้องตรงกับ
`<WEB_ORIGIN>/mcp/oauth/callback` ด้วย ซึ่งเป็นการตรวจแยกต่างหากโดยบริการภายนอก
ดู [MCP servers](../self-host-integrations.md#mcp-servers)
