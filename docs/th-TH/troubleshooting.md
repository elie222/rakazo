# แก้ปัญหา

ถ้าแอปแสดง **Troubleshoot** ให้กดลิงก์นั้นก่อน ถ้าคุณไม่ได้ดูแลเซิร์ฟเวอร์ ส่งหน้านี้ให้ผู้ดูแล

## ให้ AI ช่วย

คัดลอก prompt นี้ เติมช่อง แล้วให้ผู้ช่วยอ่านส่วนที่เกี่ยวกับ error ก่อนแนะนำการแก้ อย่าส่งรหัสผ่าน API key token cookie หรือทั้งไฟล์ `.env` ตรวจคำสั่งก่อนรัน

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

## MCP OAuth redirect ไม่ตรง

**รหัส:** `MCP_OAUTH_REDIRECT_MISMATCH`

แอปสร้าง callback จาก URL ในเบราว์เซอร์ API ยอมรับแค่ origin ที่ตั้งใน `WEB_ORIGIN` ถ้าไม่ตรงจะ error ก่อนไปหา IdP ภายนอก

1. คัดลอก origin จากแถบที่อยู่ (scheme + hostname + port ไม่มี path) เช่น `https://app.example.com` หรือ `http://127.0.0.1:5173`
2. เปิด Rakazo ที่ origin เดียวกับ `WEB_ORIGIN` — `localhost` กับ `127.0.0.1` ถือว่าคนละค่า เช่นเดียวกับ HTTP กับ HTTPS หรือพอร์ตที่ต่างกัน
3. ถ้าตั้งผิด แก้ `WEB_ORIGIN` ให้ตรงกับที่คนใช้จริง production ตั้ง HTTPS แล้วให้ `BETTER_AUTH_URL` และ `API_URL` ตรงกัน
4. **recreate** คอนเทนเนอร์ API ด้วย Compose และ env เดิม — restart อย่างเดียวไม่อัปเดต env
5. เปิด origin ที่เลือกแล้วเชื่อม integration ใหม่

ถ้าลงทะเบียน OAuth client เอง redirect ต้องรวม `<WEB_ORIGIN>/mcp/oauth/callback` ด้วย

ถ้ายังไม่หาย รายงาน bug ที่ GitHub พร้อมรหัส error เวอร์ชัน วิธีติดตั้ง และขั้นตอนทำซ้ำ **ลบ secret และข้อมูลส่วนตัวก่อนส่ง**
