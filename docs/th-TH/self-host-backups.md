# สำรองและกู้คืน

[English](../self-host-backups.md) | ไทย

สำรองฐานข้อมูลและข้อมูลแอป เก็บสำเนาเข้ารหัสไว้นอกเซิร์ฟเวอร์ และกู้คืนไปยัง snapshot หรือช่วงเวลาที่ต้องการ

## สำรองจาก source checkout

```bash
./scripts/backup.sh
```

สคริปต์นี้ dump Postgres (`pg_dump`) และ archive `data/` ไว้ใน `backups/<stamp>/` โฟลเดอร์สำรองมีสิทธิ์ `0700` และไฟล์ทั้งสองมีสิทธิ์ `0600` แม้ใช้ path เดิมซ้ำ ถ้าไม่มี `data/` การสำรองจะ fail ส่วน `RAKAZO_BACKUP_SKIP_HOMES=1` สำรองเฉพาะฐานข้อมูลและเขียน archive ว่าง ซึ่งตอน restore จะถือว่าไม่ได้รวม homes ไว้ ถ้า dump หรือ archive ล้มเหลว backup เดิมที่ใช้ stamp เดียวกันจะยังอยู่ครบ ใช้ stamp ใหม่ถ้าปลายทางมีไฟล์อื่นอยู่ สคริปต์สงวน `backups/.pending/` ไว้สำหรับงานที่ยังไม่เสร็จ ถ้าการรันถูก kill ระหว่างเผยแพร่ ให้ตรวจว่าไม่มีการสำรองใดกำลังรัน และถ้า stamp เดิมหายไป ให้กู้ `.pending/<stamp>/previous` กลับมาก่อนล้างโฟลเดอร์ staging ของ stamp นั้น

## กู้คืน

สำหรับ backup ที่สร้างด้วย `scripts/backup.sh` ให้ใช้ฐานข้อมูลว่างใน Compose stack สำหรับ development ทั้งสองสคริปต์ใช้ค่า `POSTGRES_USER` และ `POSTGRES_DB` ของคอนเทนเนอร์ Postgres (ค่าเริ่มต้นใน Compose คือ `rakazo`) สคริปต์จะตรวจและแตก archive ของ homes ในโฟลเดอร์สะอาดข้าง ๆ ก่อนแตะฐานข้อมูล จากนั้นหยุด API, worker และ supervisor และจะปฏิเสธถ้า `data/` เป็น symlink หรือไม่ใช่โฟลเดอร์ ก่อนรันสคริปต์ ให้หยุด bot computers และ process อื่นที่เขียนลงฐานข้อมูลหรือโฟลเดอร์นี้
สคริปต์รอให้ Postgres รับการเชื่อมต่อได้นานสุด 60 วินาที ถ้าไม่สำเร็จ สคริปต์จะพิมพ์คำสั่งสำหรับอ่าน log ของ Postgres และปล่อยให้ตัวเขียนข้อมูลหยุดอยู่

การ import SQL รันใน transaction เดียวและหยุดที่ error แรก รวมถึงกรณีชนกับตารางที่มีอยู่แล้ว archive ที่ไม่ถูกต้องหรือ import ที่ล้มเหลวจะไม่แตะโฟลเดอร์ข้อมูลปัจจุบัน เมื่อ SQL สำเร็จ สคริปต์จะย้ายโฟลเดอร์ปัจจุบันไปที่ `data.rollback.<random>/data` พิมพ์ path นั้น และแทนที่ `data/` ด้วยโฟลเดอร์ที่บันทึกไว้ ไฟล์ที่ไม่มีใน snapshot จะไม่เหลือในโฟลเดอร์ที่ใช้งาน ถ้าไม่มี archive ของ homes หรือเป็น archive ว่างจากการไม่รวม homes `data/` จะไม่เปลี่ยน ส่วน archive ที่มีโฟลเดอร์ `data/` ว่างจะแทนที่ด้วยโฟลเดอร์ว่าง

บริการของแอปจะเริ่มก็ต่อเมื่อ import และการแทนที่โฟลเดอร์สำเร็จ เมื่อเริ่มหยุดตัวเขียนข้อมูลแล้ว ถ้าเกิดความล้มเหลวหรือถูกขัดจังหวะภายหลัง สคริปต์จะพยายามหยุด API, worker และ supervisor อีกครั้ง รวมถึงบริการที่เริ่มไปแล้วก่อนการเริ่มขั้นสุดท้ายจะล้มเหลว สคริปต์คงสถานะความล้มเหลวเดิมไว้แม้การเก็บกวาดจะล้มเหลว ถ้า Docker หยุดบริการไม่ได้ ให้หยุดเองก่อนกู้คืน

ความล้มเหลวหลัง commit SQL แล้วไม่สามารถ rollback ฐานข้อมูลอัตโนมัติได้ ให้แอปหยุดอยู่ เก็บทั้งสองโฟลเดอร์ไว้ และกู้ฐานข้อมูลที่ตรงกันก่อนย้ายโฟลเดอร์ rollback กลับไปเป็น `data/` ถ้าต้องการ rollback แบบนั้น ให้เก็บ backup ฐานข้อมูลแยกจากก่อนการกู้คืนไว้ สคริปต์นี้ไม่ใช้ `rakazo.dump` แบบ custom format หรือ `appdata.tgz` ของ snapshot production

```bash
./scripts/restore.sh backups/<stamp>
```

## สำรองบน production

สำหรับ production แบบ VM เดียว ให้ติดตั้ง `infra/compose/backup-prod.sh` เป็น `/usr/local/sbin/rakazo-backup` และเปิด `rakazo-backup.timer` ที่ให้มา สคริปต์สร้าง dump ของ Postgres แบบ custom format ที่ตรวจแล้ว พร้อม archive ข้อมูลแอปไว้ใต้ `/var/backups/rakazo` ด้วยสิทธิ์ `0600` เก็บ snapshot ที่ตรวจแล้วได้สูงสุด `RAKAZO_BACKUP_KEEP` ชุด (ค่าเริ่มต้น `3`) ภายใต้ขีดจำกัด `RAKAZO_BACKUP_MAX_GB` (ค่าเริ่มต้น `50` GiB) และกันพื้นที่ว่างไว้ `RAKAZO_BACKUP_MIN_FREE_GB` (ค่าเริ่มต้น `5` GiB) ก่อนเริ่ม สคริปต์ลบ snapshot ที่ค้างไม่ครบและประวัติที่เกิน แล้วประเมินพื้นที่โดยปรับขนาด archive appdata ครั้งก่อนตามการเติบโตของข้อมูล appdata บวกขนาด dump ฐานข้อมูลครั้งก่อน snapshot ที่ไม่มี metadata ขนาดต้นทางจะใช้ขนาดต้นทางจริงในการประเมินครั้งแรก ถ้าพื้นที่ไม่พอ สคริปต์จะเก็บ snapshot ที่ตรวจแล้วล่าสุดไว้ จำกัดขนาดไฟล์ผลลัพธ์ และลบ snapshot ที่ไม่ครบของการรันที่ล้มเหลว snapshot ที่อยู่ในเครื่องอย่างเดียวจะหายไปพร้อมเครื่อง ให้เข้ารหัสและคัดลอกไปเก็บนอกไซต์ตามด้านล่าง

การสำรองตามกำหนดเวลาใช้ `/srv/rakazo` เป็นค่าเริ่มต้น ถ้า deploy ไว้ที่อื่น ให้ตั้ง `RAKAZO_DEPLOY_DIR=/absolute/path/to/checkout` ใน `/etc/rakazo/backup.env` ที่ root เป็นเจ้าของ (สิทธิ์ `0600`) service อ่านไฟล์ทางเลือกนี้ทุกครั้งที่รัน และสคริปต์ใช้ `.env` กับไฟล์ production Compose ของ checkout ที่เลือก ถ้าเริ่ม stack ด้วย `-p` แบบกำหนดเอง ให้ตั้ง `COMPOSE_PROJECT_NAME` เดียวกันในไฟล์นั้น และตั้งค่าการเก็บรักษาและพื้นที่ไว้ที่นั่นด้วย เมื่ออัปเดตการติดตั้งเดิม ให้ติดตั้งสคริปต์และ unit ใหม่ แล้วรัน `systemctl daemon-reload` การ pull repository ไม่ได้อัปเดตสำเนาใน `/usr/local/sbin`

### การติดตั้งด้วย published images

สคริปต์เดียวกันสำรองการติดตั้งที่ทำด้วย `install-images.sh` ซึ่งไม่มี checkout ได้ ตั้ง `RAKAZO_DEPLOY_DIR` เป็นโฟลเดอร์ที่มี `docker-compose.images.yml` และ `.env` ถ้าไม่มีไฟล์ production Compose ในนั้น สคริปต์จะใช้ `docker-compose.images.yml` และ `docker-compose.override.yml` ถ้ามี ถ้าใช้ชุดไฟล์อื่น ให้ระบุใน `RAKAZO_COMPOSE_FILE` ตามลำดับ เป็น path ภายในโฟลเดอร์ deploy และคั่นแบบเดียวกับที่ [updater](./self-host-upgrading.md#deployment-ที่ซ้อนไฟล์-compose-overlay) ใช้ รายการที่ตั้งไว้ใน `.env` ของ deployment สำหรับ updater อยู่แล้วจะใช้ตามนั้น ส่วนค่าใน `/etc/rakazo/backup.env` จะใช้แทน

ดาวน์โหลดสคริปต์และ unit ของ release ที่คุณใช้ แล้วเปิด timer:

```bash
base=https://raw.githubusercontent.com/elie222/rakazo/vX.Y.Z/infra
sudo curl -fsSL "$base/compose/backup-prod.sh" -o /usr/local/sbin/rakazo-backup
sudo chmod 755 /usr/local/sbin/rakazo-backup
for unit in rakazo-backup.service rakazo-backup.timer; do
  sudo curl -fsSL "$base/systemd/$unit" -o "/etc/systemd/system/$unit"
done
sudo install -d -m 700 /etc/rakazo
printf '\nRAKAZO_DEPLOY_DIR=%s\n' "$PWD" | sudo tee -a /etc/rakazo/backup.env >/dev/null
sudo chmod 600 /etc/rakazo/backup.env
sudo systemctl daemon-reload
sudo systemctl enable --now rakazo-backup.timer
sudo systemctl start rakazo-backup.service
```

รันจากโฟลเดอร์ deploy โฟลเดอร์ deploy จะถูกเพิ่มลงใน `/etc/rakazo/backup.env` เป็นบรรทัดของตัวเอง โดยไม่แทนที่ค่าที่มีอยู่ คำสั่งสุดท้ายสำรองครั้งแรกทันที ถ้าตั้งค่าผิดจะเห็นใน `journalctl -u rakazo-backup.service` ทันที ขั้นตอนกู้คืนด้านล่างใช้ได้กับไฟล์ Compose และชื่อ volume ของคุณเอง backup ครั้งแรกนั้นยังเป็น plaintext จนกว่าจะตั้ง recipients ตาม[การสำรองแบบเข้ารหัสและนอกไซต์](#การสำรองแบบเข้ารหัสและนอกไซต์) และ drill อ่านได้เฉพาะ snapshot ที่เข้ารหัส สคริปต์ drill ไม่ได้มากับการติดตั้งนี้ ที่เครื่องที่เก็บ identity file ให้ดาวน์โหลดแล้วรันกับ snapshot เข้ารหัสที่คัดลอกมาไว้:

```bash
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/vX.Y.Z/infra/compose/backup-drill.sh
bash backup-drill.sh ./<stamp> rakazo-backup.key
```

stack นี้รัน Postgres 16 ดังนั้น drill ต้องใช้ `pg_restore` 16 ขึ้นไป รายการไฟล์ใน `.env` ที่ใช้การอ้างอิงแบบ `$` จะถูกปฏิเสธ เพราะสคริปต์ไม่ขยายค่านั้น ให้ตั้งรายการแบบตรง ๆ ใน `/etc/rakazo/backup.env`

ถ้าใช้ดิสก์สำรองแยก ให้ mount แบบถาวรและ bind โฟลเดอร์ `backups` ของดิสก์นั้นไปที่ `/var/backups` ใน `/etc/fstab` เพิ่ม `x-systemd.requires-mounts-for=/mnt/your-backup-volume` ใน option ของ bind mount ตั้ง `RAKAZO_BACKUP_REQUIRE_VOLUME=1` และเพิ่ม drop-in ของ service ที่มี `RequiresMountsFor=/var/backups` และ `AssertPathIsMountPoint=/var/backups` ใต้ `[Unit]` จากนั้นสคริปต์จะไม่ยอมไปเขียนลงพื้นที่ root ถ้า mount หายหรือชี้ไปที่ filesystem root

## การสำรองแบบเข้ารหัสและนอกไซต์

backup ถูกเข้ารหัสด้วย [age](https://age-encryption.org) ไปยัง public recipients เท่านั้น เครื่องจึงเขียน backup ได้แต่อ่านไม่ได้ สร้างคู่กุญแจบนเครื่องที่คุณควบคุม ไม่ใช่บนเซิร์ฟเวอร์ และเก็บ identity file (private key) ไว้ออฟไลน์ ควรมี recipient ที่สองซึ่งผู้ดูแลอีกคนถือไว้:

```bash
age-keygen -o rakazo-backup.key   # prints "Public key: age1..."
```

`harden-host.sh` ติดตั้ง `age` ให้ บนเครื่องอื่นให้รัน `apt-get install age` จากนั้นตั้ง public key ใน `/etc/rakazo/backup.env` คั่นด้วยช่องว่าง หรือชี้ไปที่ไฟล์ recipients ที่มี key บรรทัดละหนึ่งตัว:

```env
RAKAZO_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# or: RAKAZO_BACKUP_AGE_RECIPIENTS_FILE=/etc/rakazo/backup-recipients.txt
```

เมื่อตั้ง recipients แล้ว แต่ละ snapshot จะมี `rakazo.dump.age`, `appdata.tgz.age`, `SOURCE_SIZE_KB` และ `SHA256SUMS` `pg_dump` และ `tar` ส่งข้อมูลเข้า age โดยตรง plaintext จึงไม่เคยลงดิสก์ การตรวจสอบไม่ต้องใช้ private key: `pg_restore --list` และ `tar -t` อ่าน plaintext stream เดียวกันระหว่างเข้ารหัส ทุกไฟล์ต้องมี age header และ checksum ครอบคลุมไฟล์ที่เข้ารหัสแล้ว

ถ้าไม่มี recipients backup จะเป็น plaintext เหมือนเดิม เขียนคำเตือนใน log และ host check จะแจ้งเตือนว่า backup ล่าสุดไม่ได้เข้ารหัส หลังจาก backup เข้ารหัสครั้งแรก การรันโดยไม่มี recipients จะ fail แทนที่จะเขียน plaintext เงียบ ๆ ตั้ง `RAKAZO_BACKUP_ALLOW_PLAINTEXT=1` เฉพาะเมื่อตั้งใจยอมรับ plaintext ค่านี้ยังปิดการแจ้งเตือนของ host check ด้วย

สำหรับสำเนานอกไซต์ ติดตั้ง `rclone` และตั้ง `RAKAZO_BACKUP_OFFSITE_REMOTE` เป็น [rclone remote](https://rclone.org/overview/) ใดก็ได้พร้อม path เช่น bucket ที่รองรับ S3 หรือเซิร์ฟเวอร์ SFTP ตั้งค่า remote ด้วยค่าของ rclone เองในไฟล์เดียวกัน เช่น:

```env
RAKAZO_BACKUP_OFFSITE_REMOTE=offsite:rakazo-backups
RAKAZO_BACKUP_OFFSITE_KEEP=14
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.example.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=replace-me
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=replace-me
```

หลังได้ snapshot ในเครื่องที่ตรวจแล้วแต่ละชุด ไฟล์ที่เข้ารหัสจะถูกอัปโหลดไปที่ `<remote>/<stamp>/` ตรวจด้วย `rclone check` แล้วจึงใส่ `SHA256SUMS` ซึ่งเป็นตัวบอกว่าสำเนาครบแล้ว สำเนานอกไซต์ต้องเข้ารหัส remote เก็บ snapshot ที่ครบล่าสุด `RAKAZO_BACKUP_OFFSITE_KEEP` ชุด (ค่าเริ่มต้น `14`) แยกจาก `RAKAZO_BACKUP_KEEP` และลบเฉพาะโฟลเดอร์ที่ตั้งชื่อตาม stamp ตั้งเป็น `0` เพื่อให้ lifecycle rules ของ bucket จัดการการลบแทน credentials จึงต้องการแค่สิทธิ์ list, read และ write ไม่ต้องมีสิทธิ์ delete ถ้าอัปโหลดล้มเหลว snapshot ในเครื่องยังอยู่ แต่ service จะ fail เพื่อให้การแจ้งเตือน backup ทำงาน

## กู้คืน backup ที่เข้ารหัส

รันขั้นตอนเหล่านี้บนเครื่องที่มี identity file และอย่าทิ้งไฟล์นั้นไว้บนเซิร์ฟเวอร์ ดึง snapshot ด้วย `rclone copy offsite:rakazo-backups/<stamp> ./<stamp>` หรือ `scp` แล้วรัน drill ซึ่งตรวจ checksum และถอดรหัสแต่ละไฟล์เข้า `pg_restore --list` และ `tar -t` โดยไม่เขียน plaintext (ต้องมี `age`, `pg_restore` เวอร์ชันหลักเดียวกับเซิร์ฟเวอร์หรือใหม่กว่า ซึ่งคือ 18 สำหรับไฟล์ production Compose และ `tar`):

```bash
bash infra/compose/backup-drill.sh ./<stamp> rakazo-backup.key
```

**อย่า extract appdata ทับ volume ที่กำลังใช้งาน** ไฟล์ที่สร้างหลัง snapshot จะยังอยู่และปนกับฐานข้อมูลที่กู้คืน ให้ extract ลงโฟลเดอร์สะอาดข้าง ๆ แล้วเก็บโฟลเดอร์เดิมไว้ก่อนแทนที่ หยุด deploy อัตโนมัติและ updater ระหว่างกู้คืน หยุด process อื่นที่เขียนลงฐานข้อมูลหรือ volume นี้ ถ้าขั้นใดล้มเหลว ให้แอปหยุดอยู่

รันคำสั่งเหล่านี้ใน Bash session เดียวบนเครื่องที่มี identity file แก้ชื่อ snapshot และ volume ก่อน `VOLUME` ต้องเป็น volume ที่ API mount อยู่ที่ `/data` ในขณะนี้ ซึ่งอาจต่างไปถ้า stack ใช้ชื่อ project อื่น

```bash
set -euo pipefail
umask 077
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
VOLUME=rakazo-prod_appdata

ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web"
ROLLBACK_DUMP="$(mktemp "$PWD/before-restore.dump.XXXXXX")"
if ! ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_dump -Fc -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'" \
  > "$ROLLBACK_DUMP"; then
  printf 'Pre-restore dump failed. Do not use the partial file at %s. Keep the application stopped.\n' "$ROLLBACK_DUMP" >&2
  exit 1
fi

APPDATA="$(ssh deploy@app.example.com "sudo docker volume inspect -f '{{.Mountpoint}}' '$VOLUME'")"
RESTORE="$(ssh deploy@app.example.com "sudo mktemp -d '${APPDATA%/*}/rakazo-restore.XXXXXX'")"
ssh deploy@app.example.com "sudo mkdir '$RESTORE/staged'"
printf 'Record this rollback pair:\nDatabase dump: %s\nData tree on deploy@app.example.com: %s/previous\n' \
  "$ROLLBACK_DUMP" "$RESTORE"
age -d -i rakazo-backup.key <stamp>/appdata.tgz.age | ssh deploy@app.example.com \
  "sudo tar -xzf - --numeric-owner -C '$RESTORE/staged'"

age -d -i rakazo-backup.key <stamp>/rakazo.dump.age | ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"'"

ssh deploy@app.example.com \
  "sudo mv -- '$APPDATA' '$RESTORE/previous' && sudo mv -- '$RESTORE/staged' '$APPDATA'"
ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE up -d --force-recreate --wait --pull never api worker web"
```

archive ต้องแตกสำเร็จก่อนเริ่ม import SQL โฟลเดอร์ staging ที่สะอาดและโฟลเดอร์ rollback อยู่ข้างโฟลเดอร์ข้อมูลที่ใช้งานของ volume บน filesystem เดียวกัน การสร้างคอนเทนเนอร์ของแอปใหม่ทำให้คอนเทนเนอร์ mount โฟลเดอร์ที่แทนที่แล้ว `--single-transaction` rollback error ของ SQL ได้ แต่ไม่ครอบคลุมการสลับโฟลเดอร์ หลัง import commit แล้ว ถ้าการสลับหรือการเริ่มระบบล้มเหลว ฐานข้อมูลกับโฟลเดอร์ที่ใช้งานอาจไม่ตรงกัน ถ้าเริ่มระบบไม่สำเร็จ ให้หยุด `api worker web` อีกครั้ง รวมถึงคอนเทนเนอร์ที่เริ่มไปแล้ว

`$ROLLBACK_DUMP` คือชื่อไฟล์ rollback dump ที่เป็นส่วนตัวและเป็น plaintext `mktemp` สร้างไฟล์ใหม่สิทธิ์ `0600` ทุกครั้งที่ลอง โดยไม่เขียนทับ `before-restore.dump`, rollback dump ก่อนหน้า หรือเป้าหมายของ symlink ที่มีอยู่ ถ้า dump ล้มเหลว คำสั่งจะหยุดโดยแอปยังหยุดอยู่ ไฟล์ไม่ครบที่พิมพ์ออกมาใช้เป็นข้อมูล rollback ไม่ได้ เก็บคู่ rollback ก่อนหน้าไว้ และแก้ปัญหา dump ก่อนเริ่มกู้คืนรอบใหม่

จด path ของ database dump ที่พิมพ์ออกมาคู่กับ path ของโฟลเดอร์ `$RESTORE/previous` บนเครื่องปลายทางที่ตรงกัน เก็บคู่นั้นไว้จนกว่าจะตรวจแอปที่กู้คืนแล้ว อย่าลบ Docker volume ขณะยังต้องใช้โฟลเดอร์ rollback ถ้าต้อง rollback หลัง SQL commit แล้ว ให้แอปหยุดอยู่ และกู้ `$ROLLBACK_DUMP` ที่จดไว้ลงฐานข้อมูลว่างที่สร้างใหม่ ย้ายโฟลเดอร์ที่ใช้งานซึ่งล้มเหลวไปไว้ path อื่นเพื่อตรวจสอบ แล้วย้ายโฟลเดอร์ `$RESTORE/previous` ที่จดไว้ของรอบนั้นกลับไปที่ `$APPDATA` และสร้างคอนเทนเนอร์ของแอปใหม่ ถ้าการย้ายโฟลเดอร์ครั้งแรกล้มเหลว โฟลเดอร์เดิมยังอยู่ที่ `$APPDATA` ตรวจทั้งสอง path ก่อนย้ายอะไร การสลับโฟลเดอร์อย่างเดียวไม่ได้ rollback ฐานข้อมูล

snapshot แบบ plaintext ใช้ `cat` แทน `age -d` และใช้ชื่อไฟล์ `rakazo.dump` และ `appdata.tgz` ใช้ขั้นตอนโฟลเดอร์สะอาดแบบเดียวกัน

ถ้ากู้คืนลง stack ใหม่ ให้สร้าง role `rakazo_app` ก่อนทำขั้นตอนด้านบน dump มีการ grant ให้ role นี้ และบน stack ใหม่มีแค่ขั้น migration ที่จะสร้าง role นี้ `pg_restore` จึงหยุดถ้าไม่มี อย่ารัน migration ก่อน เพราะตารางที่ใหม่กว่า snapshot จะขวางการกู้คืน การเริ่มระบบขั้นสุดท้ายของขั้นตอนจะ apply migration ให้เอง

```bash
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait postgres"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE\"'"
```

## กู้คืนไปยังช่วงเวลาที่ต้องการ

backup รายคืนอาจเสียข้อมูลได้ถึงหนึ่งวัน การกู้คืนไปยังช่วงเวลาที่ต้องการ (point-in-time recovery) ส่ง write-ahead log (WAL) ของฐานข้อมูลไปยัง object storage ที่รองรับ S3 อย่างต่อเนื่อง และทำ base backup ทุก 24 ชั่วโมง จึงกู้ฐานข้อมูลไปยังเวลาใดก็ได้ภายใน `PITR_RETAIN_DAYS` วันล่าสุด (ค่าเริ่มต้น `7`) และถ้าเซิร์ฟเวอร์หายจะเสียการเขียนประมาณหนึ่งนาที ครอบคลุมเฉพาะฐานข้อมูล ยังต้องมี backup รายคืนสำหรับข้อมูลแอป ปิดเป็นค่าเริ่มต้น และต้องใช้ไฟล์ production Compose กับ Postgres 18

service `pitr` ที่เป็นทางเลือกส่ง WAL ด้วย `pg_receivewal` ผ่านเครือข่ายภายใน `data` โดยใช้ login ที่ทำได้แค่ replication และ replication slot แล้วอัปโหลดจากเครือข่ายของตัวเอง Postgres จึงไม่ต้องเข้าถึงอินเทอร์เน็ต Postgres ปิด WAL segment อย่างน้อยทุกนาทีขณะมีการเขียน (`archive_timeout`) แต่ละ segment และ base backup ถูกเข้ารหัสด้วย [age](https://age-encryption.org) ไปยัง public recipients ก่อนออกจากคอนเทนเนอร์ เหมือน backup รายคืน เซิร์ฟเวอร์จึงอ่าน backup ของตัวเองไม่ได้ ใช้ recipients ชุดเดียวกันได้

slot เก็บ WAL ที่ยังไปไม่ถึง sidecar ไว้ การ restart sidecar จึงไม่ทำให้ข้อมูลขาดช่วง การใช้ดิสก์มีขีดจำกัดแม้การอัปโหลดค้าง: sidecar เก็บ WAL ที่บีบอัดแล้วซึ่งรออัปโหลดได้สูงสุด `PITR_MAX_WAL_GB` (ค่าเริ่มต้น `4`) แล้วหยุดรับข้อมูลชั่วคราว และ Postgres เก็บให้ slot ได้อีกไม่เกินเท่านั้น (`max_slot_wal_keep_size`) ถ้าเกินกว่านั้น Postgres จะทิ้ง WAL ของ slot การกู้คืนจะขาดช่วง และ sidecar จะทำ base backup ใหม่เมื่อเชื่อมต่อได้อีกครั้ง

ใช้ bucket แยกเฉพาะ credentials ต้อง list, read, write และ delete object ใน bucket นั้นได้ การลบจะลบเฉพาะ backup ที่เก่ากว่าช่วงเก็บรักษา ถ้า `PITR_RETAIN_DAYS=0` จะไม่ลบอะไร จึงไม่ต้องมีสิทธิ์ delete และให้ lifecycle rules ของ bucket จัดการการหมดอายุ เพิ่มใน `.env`:

```env
COMPOSE_PROFILES=pitr
PITR_DATABASE_PASSWORD=replace-with-openssl-rand-hex-24
PITR_BUCKET=example-rakazo-pitr
PITR_ENDPOINT=https://s3.example.com
PITR_REGION=example-region
PITR_ACCESS_KEY_ID=replace-me
PITR_SECRET_ACCESS_KEY=replace-me
PITR_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# Optional: PITR_PREFIX (a key prefix), PITR_PATH_STYLE=true (path-style bucket addressing),
# PITR_RETAIN_DAYS, PITR_MAX_WAL_GB.
```

`COMPOSE_PROFILES` คั่นด้วยจุลภาค ถ้าใช้ updater ด้วยจะเป็น `updater,pitr` สำหรับ AWS S3 ไม่ต้องตั้ง `PITR_ENDPOINT` จากนั้นเปิดใช้จาก checkout:

```bash
sudo infra/compose/pitr.sh enable
```

คำสั่งนี้สร้าง replication login `rakazo_pitr` อนุญาตใน `pg_hba.conf` ตั้ง `archive_timeout` และ `max_slot_wal_keep_size` แล้ว reload Postgres โดยไม่ restart จากนั้น sidecar จะทำ base backup แรก รัน `enable` อีกครั้งหลังเปลี่ยน `PITR_DATABASE_PASSWORD` หรือ `PITR_MAX_WAL_GB` หรือหลังย้าย Postgres ไป cluster ใหม่ การอัปโหลดแยกกลุ่มตาม system identifier ของ cluster ดังนั้น cluster ใหม่จะไม่เขียนทับ WAL ของ cluster เก่า

health check ของ sidecar จะ fail เมื่อมีการอัปโหลดรอนานเกินสิบนาที การรับข้อมูลหยุดชั่วคราว ไม่มีอะไรส่งจาก slot หรือ base backup ล่าสุดเก่ากว่า 30 ชั่วโมง ถ้าตั้ง `RAKAZO_MONITOR_COMPOSE_PROJECT` ไว้ host check จะแจ้งเตือนเรื่องนี้ ดูรายละเอียดด้วย:

```bash
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec pitr rakazo-pitr health
```

การกู้คืนรันได้บนเครื่องใดก็ได้ที่มี Docker และ checkout นี้ identity ส่งเข้าทาง stdin และอยู่ในหน่วยความจำภายในคอนเทนเนอร์กู้คืนเท่านั้น พิสูจน์ว่าจุดล่าสุดกู้คืนได้ โดยกู้ลง volume ชั่วคราวที่จะถูกลบภายหลัง รันหลังเปิดใช้ หลังเปลี่ยนสคริปต์ PITR และเป็นระยะ:

```bash
sudo infra/compose/pitr.sh drill < rakazo-backup.key
```

เมื่อรันนอกเซิร์ฟเวอร์ ให้ตั้ง `PITR_ENV_FILE` เป็นไฟล์ที่มีเฉพาะค่า storage `PITR_` ถ้าจะกู้ production ไปยังเวลาที่ต้องการ ให้หยุดทุกอย่างที่เขียนลงฐานข้อมูลแล้วกู้ลง volume ของมัน cluster ปัจจุบันจะถูกย้ายไปไว้ข้าง ๆ ภายใน volume ไม่ได้ถูกลบ เวลาจะอ่านเป็น UTC เว้นแต่ระบุ zone:

```bash
COMPOSE="sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE stop api worker web pitr postgres"
ssh deploy@app.example.com \
  "cd /srv/rakazo && sudo infra/compose/pitr.sh restore '2026-01-31 09:41:00+00' rakazo-prod_postgres" \
  < rakazo-backup.key
ssh deploy@app.example.com "cd /srv/rakazo && $COMPOSE up -d --wait"
```

การกู้คืนใช้ base backup ล่าสุดที่เสร็จก่อนเวลาเป้าหมาย replay WAL จนถึงเวลานั้น แล้ว promote ผลลัพธ์ ซึ่งเริ่ม timeline ใหม่ และ sidecar จะทำ base backup ใหม่ให้ timeline นั้น หยุด deploy จาก CI ระหว่างกู้คืน เมื่อตรวจฐานข้อมูลที่กู้คืนแล้วว่าถูกต้อง ให้ลบ cluster เก่า:

```bash
ssh deploy@app.example.com \
  "cd /srv/rakazo && $COMPOSE run --rm --no-deps --entrypoint sh postgres -c 'rm -rf \"\$PGDATA\".before-restore-*'"
```

ถ้าจะปิด ให้เอา `pitr` ออกจาก `COMPOSE_PROFILES` แล้วรัน `sudo infra/compose/pitr.sh disable` คำสั่งนี้ลบ sidecar, slot (Postgres จึงเลิกเก็บ WAL ไว้ให้), login และค่าที่ตั้งไว้ backup ที่อัปโหลดแล้วยังอยู่ใน bucket

## ย้ายบัญชีระหว่างการติดตั้ง

ถ้าจะย้ายจาก Rakazo Cloud มาที่การติดตั้งของคุณเอง (หรือกลับ) ให้ใช้ **ตั้งค่า (Settings) → Export data** บนการติดตั้งเดิม และ **Import data** บนการติดตั้งใหม่ ไฟล์ export เป็น zip ของทุก space ที่คุณเป็นสมาชิก: bot, แชท, ไฟล์, memory, routine, skill, ไฟล์ใน workspace ของ bot และใน space ที่คุณเป็นเจ้าของจะรวม board ด้วย เนื้อหาใน zip ถูกถอดรหัสแล้ว จึงต้องเก็บเป็นความลับ การ import จะสร้าง space ใหม่ที่คุณเป็นเจ้าของ routine จะถูกปิดไว้ credentials และการเชื่อมต่อ (key ของโมเดล แอป MCP server และ messaging) ไม่ถูกย้ายไปด้วย ให้เชื่อมใหม่บนการติดตั้งใหม่ ไฟล์ workspace ที่ใหญ่เกิน 8 MiB จะไม่ถูกรวม ไฟล์ export ต้องเล็กกว่า 4 GiB และการอัปโหลดต้องเสร็จภายใน request timeout ของเซิร์ฟเวอร์ (ค่าเริ่มต้น 5 นาทีใน Node)
