# อัปเกรด

ย้าย deployment ไปเวอร์ชันใหม่ สำรองก่อน แล้วอัปเดต tag/image

## อัปเกรด Compose (release tag)

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

แท็ก `local` ไม่มีใน registry — ใช้ `git pull` แล้ว build:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

สำรองก่อนอัปเกรด ถ้า recreate ล้มเหลวกู้ด้วย `RAKAZO_IMAGE_TAG` เดิม (หรือ rebuild `local`)

## อัปเกรด `rakazo_app` login แยก

release ใหม่ต้องมี `POSTGRES_APP_PASSWORD` ใน `.env` (`openssl rand -hex 16`) ก่อน pull ไม่งั้น Compose fail ที่ validate API สร้าง role `rakazo_app` ครั้งแรกที่สตาร์ท

## อัปเกรด Postgres 18

volume Postgres 16 เก่าเปิดบน 18 ไม่ได้ — container จะ exit พร้อมข้อความใน log **ไม่ลบข้อมูลเอง**

สำรองและซ้อมกู้คืนก่อน จาก checkout:

```bash
cd /srv/rakazo
git pull --ff-only
sudo infra/compose/upgrade-postgres.sh
```

สคริปต์จะหยุดสแตก คัดลอกจาก Postgres 16 ไป 18 ตรวจ role และ grants แล้วสลับ volume ถ้าล้มเหลวกลางทาง สแตกจะหยุด แต่ข้อมูลของ Postgres 16 ยังเหมือนเดิม

## Deploy directory เดียว

`RAKAZO_DEPLOY_DIR` ต้องเป็น path ที่ **daemon Docker** เห็น (Linux มักเป็น `/srv/rakazo`) updater bind mount path เดียวกัน — path ผิดจะได้โฟลเดอร์ว่างแทน `.env` จริง

Docker Desktop (Windows/macOS): ใช้ path ใน VM เช่น `/run/desktop/mnt/host/c/Users/you/rakazo` ไม่ใช่ `C:\...` หรือ `/mnt/c/...` ที่มักว่าง

## Updater sidecar (ทางเลือก)

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

ต้องมี `RAKAZO_UPDATER_TOKEN` แยกจาก secret อื่น อย่างน้อย 32 ตัวอักษร เรียก `/apply` `/rollback` ผ่านเครือข่าย `control` เท่านั้น

แท็ก image: `edge`, `vX.Y.Z`, `sha-<commit>` — อย่าอาศัย `latest` จนกว่า registry จะมีจริง
