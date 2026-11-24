# อัปเกรด

[English](../self-host-upgrading.md) | ไทย

ย้าย deployment ไป release ใหม่ จัดการ migration ที่ทำครั้งเดียว และให้ updater sidecar ทำแทนคุณ

## อัปเกรด

deployment แบบ Compose ที่ใช้ release tag ที่เผยแพร่แล้ว อัปเกรดด้วยการเลื่อน tag นั้น:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

deployment ที่ใช้ tag `local` ซึ่งเป็นค่าเริ่มต้นไม่มี registry ให้ pull จึงอัปเกรดด้วยการ build checkout ใหม่แทน:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` จะไม่รายงานว่าสำเร็จจนกว่า API ใหม่จะ healthy และคอนเทนเนอร์ worker กับ web กำลังรัน Compose หยุด worker เก่าก่อนเริ่มตัวใหม่ และการหยุดจะรอให้งานที่กำลังรันเสร็จนานสุด 50 นาทีแทนที่จะตัดทิ้ง งานใหม่เริ่มเมื่อ worker ใหม่ขึ้นแล้ว API เริ่มหลังคอนเทนเนอร์ `migrate` ทำงานเสร็จเท่านั้น ถ้า migration ล้มเหลว API ใหม่จึงไม่เริ่ม การ recreate ผ่าน CLI ที่ล้มเหลวจะไม่ rollback อัตโนมัติ ให้กู้ด้วย `RAKAZO_IMAGE_TAG` เดิม (หรือ build `local` ใหม่) แล้วรัน `up -d --wait --pull never`

updater sidecar มี image และ tag ของตัวเอง การอัปเดตจึงไม่เคย recreate process ที่ทำการอัปเดตอยู่ เลื่อน updater อย่างตั้งใจโดยตั้ง `RAKAZO_UPDATER_IMAGE_TAG` เป็น tag `sha-<commit>` เต็ม แล้วรัน `docker compose … pull updater && docker compose … up -d --wait --pull never updater` `/apply` และ `/rollback` ของ sidecar กู้การ recreate ที่ล้มเหลวด้วยการ deploy image เดิมที่ cache ไว้เมื่อทำได้ ถ้ายังล้มเหลวอีก จะรายงานว่า runtime อาจมีหลายเวอร์ชันปนกัน

source checkout (ไม่ใช่ Compose) ยังอัปเกรดแบบเดิม: pull, build ใหม่ด้วย `GIT_SHA=$(git rev-parse HEAD)` รัน `pnpm db:migrate` แล้ว restart API และ worker สัญญาของผลิตภัณฑ์ยังเข้ากันได้ทั้งบน cloud และ self-host

## อัปเกรดเป็น login ฐานข้อมูลแยกของแอป

release ที่มี [role ของฐานข้อมูล](./self-host-configuration.md#role-ของฐานข้อมูล) ต้องมี `POSTGRES_APP_PASSWORD` ใน `.env` แอป desktop, `install-images.sh`, updater sidecar และ `infra/compose/deploy-main.sh` จะเพิ่มให้ถ้ายังไม่มี
ที่อื่นให้เพิ่มเอง (`openssl rand -hex 16`) ก่อน pull ไม่อย่างนั้น Compose จะหยุดตอนตรวจ config ด้วย `Set POSTGRES_APP_PASSWORD in .env` เมื่อเริ่มครั้งแรก API จะสร้าง login `rakazo_app` แล้ว API และ worker จะเชื่อมต่อในนามนั้น นอกนั้นไม่มีอะไรเปลี่ยน และการอัปเกรดไม่เขียนข้อมูลใหม่

ถ้าฟีเจอร์ใดทำงานผิดภายใต้ row-level security ให้รัน `ALTER ROLE <login> BYPASSRLS;` กับ login ใน `DATABASE_URL` (`rakazo_app` ใน Compose) ในนามของ superuser (owner ของ Compose เป็น superuser) แล้ว restart API และ worker คุณสมบัติของ role ไม่ถ่ายทอดต่อ การ grant ให้ `rakazo_app` จึงไม่มีผลกับ login ที่แยกต่างหาก จากนั้นแอปจะทำงานเหมือนเดิมพร้อมคำเตือนตอนเริ่ม และ migration ภายหลังจะไม่แตะ login นั้น ยกเลิกด้วย `NOBYPASSRLS` แล้ว restart อีกครั้ง จากนั้นค้นใน log ของ API และ worker หา `violates row-level security` และ `without a tenant or system context` release เก่าจะไม่สนตัวแปรที่เพิ่มมาและเชื่อมต่อในนาม owner แต่ release ในวันเดียวกันยังเข้ารหัสเนื้อหาที่จัดเก็บด้วย: ให้รัน `content-encryption decrypt` ก่อน rollback ย้อนไปก่อน release เหล่านั้น ([content encryption](../content-encryption.md#rollout)) ไม่อย่างนั้น release เก่าจะแสดง ciphertext

## อัปเกรดเป็น Postgres 18

ไฟล์ Compose ของ production และ source checkout รัน Postgres 18 การติดตั้งที่สร้างก่อนหน้านั้นเก็บข้อมูลใน volume ของ Postgres 16 (`pgdata`) ซึ่ง Postgres 18 เปิดไม่ได้ จนกว่าจะคัดลอกข้อมูลไปยัง volume `postgres` ใหม่ คอนเทนเนอร์ฐานข้อมูลจะ exit และเขียน log ว่าพบข้อมูล PostgreSQL ใน `/var/lib/postgresql/16/docker` และการ deploy production จะหยุดก่อนแทนที่อะไร ไม่มีอะไรถูกลบหรือเริ่มแบบว่างเปล่า การติดตั้งใหม่ไม่ต้องทำอะไร ไฟล์ published images (`docker-compose.images.yml` ซึ่งแอป desktop ใช้ด้วย) ยังใช้ Postgres 16

สำรองข้อมูลและรัน drill กับ backup นั้นก่อน ([การสำรองแบบเข้ารหัส](./self-host-backups.md#การสำรองแบบเข้ารหัสและนอกไซต์)) จากนั้นอัปเดต checkout และรันการอัปเกรดในนาม root:

```bash
cd /srv/rakazo
git pull --ff-only
sudo infra/compose/upgrade-postgres.sh
```

ถ้า stack ใช้ไฟล์ Compose อื่นด้วย เช่น overlay ของ Docker computers หรือ stack ของ source checkout ให้ส่งทุกไฟล์: `sudo RAKAZO_DEPLOY_DIR="$PWD" infra/compose/upgrade-postgres.sh infra/compose/docker-compose.yml` ตั้ง `COMPOSE_PROJECT_NAME` ถ้า stack รันด้วย `-p` แบบกำหนดเอง และบนเครือข่ายที่จำกัด ให้ตั้ง `RAKAZO_POSTGRES_16_IMAGE` เป็น mirror ของ image Postgres 16 เดิม (ตอนนี้ `POSTGRES_IMAGE` ต้องเป็น image ของ Postgres 18)

สคริปต์จะหยุด stack คัดลอกทุก role (พร้อมรหัสผ่าน) และทุกฐานข้อมูลจาก Postgres 16 ด้วย `pg_dumpall` แล้วเปรียบเทียบ role, membership, ownership, grant, policy ของ row-level security, sequence และจำนวนแถวของทุกตาราง และตรวจว่า `rakazo_app` sign-in ด้วย `POSTGRES_APP_PASSWORD` ได้และไม่ข้าม row-level security หลังจากนั้นเท่านั้นจึงสลับไปใช้ Postgres 18 และ restart บริการที่รันอยู่ เว็บไซต์จะใช้ไม่ได้ตลอดการคัดลอก ซึ่งใช้เวลาประมาณเท่ากับการ dump และ restore ฐานข้อมูล: ไม่กี่นาทีสำหรับฐานข้อมูลขนาดเล็ก ต้องมีพื้นที่ดิสก์ว่าง 125% ของขนาดโฟลเดอร์ข้อมูลฐานข้อมูลเดิม บวก 1 GiB การรันซ้ำหลังสำเร็จแล้วจะไม่ทำอะไร ถ้าขั้นใดล้มเหลว สคริปต์จะหยุดโดย stack ยังหยุดอยู่และข้อมูล Postgres 16 ไม่เปลี่ยน แก้ error แล้วรันอีกครั้ง บนเครื่อง production ให้รัน deploy ที่หยุดไปอีกครั้งหลังจากนั้น

volume ของ Postgres 16 ยังอยู่เหมือนเดิมแบบ mount อ่านอย่างเดียว ถ้าจะ rollback ให้ checkout release ก่อนหน้าแล้วเริ่ม stack: จะรัน Postgres 16 บนข้อมูลเดิม ทุกอย่างที่เขียนหลังอัปเกรดมีอยู่บน Postgres 18 เท่านั้น จึงควร rollback ทันทีหรือไม่ rollback เลย และหยุด deploy จาก CI จนกว่าจะอัปเกรดอีกครั้ง เมื่อไม่ต้องใช้ rollback แล้ว ให้หยุด `postgres` ลบ volume `<project>_pgdata` แล้วเริ่มใหม่ Compose จะสร้าง volume นั้นใหม่แบบว่าง

## migration ขอบเขตความเป็นส่วนตัวของ Space

ก่อนอัปเกรดข้าม migration `20260830200000_space_scope_names_and_user_credentials` ให้ตรวจว่า credential ของโมเดลและเสียงทุกตัวที่มีอยู่ยังเป็นของสมาชิกใน Space ของมัน query นี้ใช้ชื่อคอลัมน์ `workspaceId` จากก่อน migration และต้องไม่คืนแถวใดเลย:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

migration นี้เปลี่ยนชื่อคอลัมน์ที่ API และ worker ใช้ จึงเป็นการสลับแบบประสานกัน ไม่ใช่ rolling migration แบบออนไลน์ หยุด API และ worker เก่า apply migration แล้วเริ่มเวอร์ชันใหม่พร้อมกัน การรอ lock มีขีดจำกัด การแย่ง lock จึงทำให้ migration ล้มเหลวแทนที่จะปล่อยให้ traffic ของแอปค้างอยู่ในคิวไม่มีกำหนด

## integration ที่เชื่อมก่อน 30 ตุลาคม 2026

integration ที่เชื่อมผ่าน Pipedream ก่อน 30 ตุลาคม 2026 บันทึกไว้แค่ชื่อแอป ไม่ได้บันทึกว่า sign-in ด้วยบัญชีใด release ตั้งแต่นั้นใช้การเชื่อมต่อเฉพาะเมื่อระบุบัญชี แอปเหล่านี้จึงไม่ให้เครื่องมือกับ bot และครั้งแรกที่ bot ลองใช้ จะขอให้ผู้ใช้เชื่อมใหม่ ถ้าต้องการหาไว้ล่วงหน้า ให้รัน:

```sql
SELECT "id", "spaceId", "provider" FROM "connections"
WHERE "connectorId" = 'pipedream' AND "status" = 'connected' AND "providerRef" = "provider";
```

เชื่อมแต่ละแอปในรายการใหม่จากหน้า Integrations ของ Space นั้น ไม่มีการเติมข้อมูลย้อนหลังอัตโนมัติ เพราะ Space หนึ่งอาจมีหลายบัญชีสำหรับแอปเดียวกัน

## image และ tag ที่เผยแพร่

`.github/workflows/publish-server-image.yml` เผยแพร่ไปที่ `ghcr.io/<owner>/<repo>/…` ซึ่งได้มาจาก `${{ github.repository }}` ไม่ได้ hardcode CI ของ fork จึงเผยแพร่ลง namespace ของ fork เอง สำหรับ repository นี้คือ:

| Image                             | เนื้อหา                                                        |
| --------------------------------- | ------------------------------------------------------------ |
| `ghcr.io/elie222/rakazo/app`      | api, worker, web และ sandbox supervisor: image เดียว หลายคำสั่ง |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop ที่ใช้เป็น computer ของแต่ละ bot                    |
| `ghcr.io/elie222/rakazo/updater`  | updater sidecar พร้อม Docker CLI                              |

`infra/compose/docker-compose.images.yml` คือทางที่ไม่ต้องมี checkout สำหรับ tag ของ app และ computer เหล่านั้น พร้อม Postgres supervisor รันจาก image ของ app บนเครือข่ายภายในเท่านั้น (ไม่มี image supervisor ที่เผยแพร่แยก และไม่มี port บนเครื่อง) production Compose (`docker-compose.prod.yml`) ก็ pull tag ของ app เดียวกันได้เมื่อตั้ง `RAKAZO_IMAGE_TAG` เป็นค่าที่เผยแพร่แล้ว

ถ้า deploy จาก fork ของคุณเอง ให้ตั้ง `RAKAZO_IMAGE` และ `RAKAZO_UPDATER_IMAGE` เป็น namespace ของคุณ เพราะ CI ของคุณเผยแพร่ลง namespace ของคนอื่นไม่ได้

| Tag                   | เผยแพร่เมื่อ                                     | เลื่อนไหม                                    |
| --------------------- | --------------------------------------------- | ------------------------------------------ |
| `local`               | ไม่เผยแพร่ build ในเครื่องด้วย `up --build`        | build ใหม่ทับที่เดิม                            |
| `local-<full-commit>` | ไม่เผยแพร่ build บนเซิร์ฟเวอร์จากการอัปเดต fork     | ไม่เลื่อน                                     |
| `vX.Y.Z`, `vX.Y`      | release tag                                   | ตามธรรมเนียมไม่เลื่อน / เลื่อนเมื่อมี patch release |
| `latest`              | เฉพาะ tag `vX.Y.Z` รุ่นเสถียร (ไม่รวม prerelease) | เลื่อนไป release เสถียรล่าสุด                   |
| `sha-<full-commit>`   | ทุก commit บน main, release tag และการรันด้วยมือ  | อ้างตาม source ใช้โดย updater sidecar        |
| `edge`                | push ไป main                                  | เลื่อนไป build ล่าสุดของ main                  |

การเผยแพร่ทุกครั้ง รวมถึง `edge` จากการ merge เข้า main เป็นแบบ multi-arch (`amd64` + `arm64`): แต่ละสถาปัตยกรรม build แบบ native บน Depot เมื่อตัวแปร repository `DEPOT_PROJECT_ID` ระบุ project ไว้ ไม่อย่างนั้นใช้ runner ของ GitHub แล้วประกอบ manifest หนึ่งชุดต่อ image build บน Depot เผยแพร่และ attest แต่ละ image ใน job เดียวกัน ส่วน build แบบ native บน GitHub รวม artifact ของแต่ละสถาปัตยกรรมใน job เผยแพร่แยก revision ของ main CI ตรวจสอบแยกกัน lock ของการเผยแพร่แยกตาม image และ build ของ main ที่ถูกแทนที่แล้วจะเก็บ commit tag ไว้โดยไม่เลื่อน `edge` คิวของ image และ release เก็บงานที่รออยู่ไว้ การรันเก่าที่ช้ากว่าจึงแทนที่การรันใหม่ไม่ได้ การ deploy production ยังทำทีละครั้ง และ deploy revision ที่ผ่านการตรวจตรงตัว ก่อน tag ใดจะชี้ไปที่ image ใหม่ของ app CI จะทำให้การเผยแพร่ล้มเหลวถ้า image มีไฟล์ `.env` โฟลเดอร์ `.git` หรือ private key (`infra/compose/check-image.sh`) จนกว่าจะเผยแพร่ `vX.Y.Z` รุ่นเสถียร GHCR อาจมีแค่ tag `edge` และ `sha-*` อย่าตรึง `latest` เว้นแต่ tag นั้นมีอยู่ใน registry

การ build image เองไม่ต้องใช้ QEMU `docker compose up --build` build สำหรับสถาปัตยกรรมของเครื่องเอง และ fork ที่เผยแพร่ image แบบ multi-arch ควรทำแบบเดียวกับ `publish-server-image.yml`: build แต่ละสถาปัตยกรรมบน runner แบบ native (GitHub Actions มี `ubuntu-24.04-arm` ให้ repository สาธารณะ) แล้วรวม digest เป็น manifest เดียว การจำลองด้วย QEMU (`docker/setup-qemu-action`, `binfmt`) ยังใช้ได้ถ้าไม่มีเครื่อง arm64 แบบ native แต่ช้ากว่าหลายเท่า เป็นชั่วโมงแทนที่จะเป็นนาทีสำหรับ image `computer`

updater หา source tag `vX.Y.Z` รุ่นเสถียรล่าสุด แต่ deploy image `sha-<full-commit>` ของ tag นั้น ไม่ใช่ `latest` หรือ minor tag ที่เลื่อนได้ tag ใน registry ไม่ใช่ OCI digest และผู้มีสิทธิ์เขียน package บน GHCR แทนที่ได้ ขอบเขตความเชื่อถือจึงยังเป็น credentials สำหรับเผยแพร่ของ repository นี้ workflow ลดขอบเขตนั้นด้วย action ที่ตรึงด้วย SHA, job ของ pull request ที่อ่านอย่างเดียว, base image ที่ตรึงด้วย digest, output แบบ SBOM/provenance และ build attestation ของ GitHub ผู้ดูแลระบบที่ต้องการระบุเนื้อหาระดับ registry ตรึง `RAKAZO_IMAGE` นอก updater อัตโนมัติด้วย digest ที่ตรวจแล้วได้

rollback ไม่ติดต่อ registry เลย: deploy tag เดิมจาก Docker cache ในเครื่อง การเลื่อน tag ภายหลังจึงเปลี่ยนเนื้อหาของ rollback ไม่ได้ อย่า prune image ของแอปเดิมจนกว่าการอัปเดตครั้งถัดไปจะได้รับการยอมรับ ถ้า image หายไป rollback จะล้มเหลวอย่างปลอดภัยแทนที่จะ pull เนื้อหาใหม่ภายใต้ tag เก่า

ถ้าจะเติม registry ครั้งแรก ให้รัน workflow ด้วยมือ (`workflow_dispatch`) หรือ push tag `v*` การรันด้วยมือได้ `sha-<full-commit>` มีเพียง tag `vX.Y.Z` รุ่นเสถียร (ไม่มี suffix prerelease) ที่ได้ `latest` และ tag `v*` ใดก็ตามได้ semver tag updater ไม่สนใจ prerelease และปฏิเสธเส้นทางทางการจนกว่าจะมี `vX.Y.Z` รุ่นเสถียร

## Updater sidecar

deployment production แบบ Compose มี profile `updater` แบบเลือกเปิดบนเครือข่ายส่วนตัว `control` deployment ปกติไม่เริ่มและไม่ต้องใช้ credential ของมัน ถ้าจะเปิด ให้ตั้ง `RAKAZO_UPDATER_TOKEN` เฉพาะ แล้วเริ่ม profile อย่างชัดเจน:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

sidecar เปิด `/health`, `/state`, `/plan`, `/apply` และ `/rollback` ที่ `http://updater:7092` พร้อม `RAKAZO_UPDATER_TOKEN` การอัปเกรดผ่าน CLI ของผู้ดูแลระบบด้านบนไม่ต้องใช้ sidecar ซึ่งมีไว้สำหรับ apply/rollback อัตโนมัติผ่าน HTTP API ส่วนตัวนั้น เฉพาะเครื่องมือ deploy ที่เรียกได้ บัญชีในแอปไม่มี endpoint สำหรับอัปเดต และ API ของแอปไม่ได้รับ token ของ updater

API อัปเดตตัวเองไม่ได้ เพราะ image ไม่มี `.git` และไม่มีอะไรในคอนเทนเนอร์ที่จะ restart มัน งานจึงทำในคอนเทนเนอร์ `updater` แยก ซึ่งอยู่รอดหลังการ recreate:

- _Repository ทางการ:_ หา release เสถียรล่าสุดและ source commit ด้วย `git ls-remote --tags` ตรึง image tag `sha-<commit>` เต็มที่ตรงกันใน `.env` เก็บ tag ที่กำลังจะเลิกใช้ไว้ใน `RAKAZO_IMAGE_TAG_PREVIOUS` pull image ใหม่อย่างชัดเจน แล้วรัน `up -d --wait --pull never` ไม่มีการ build บนเซิร์ฟเวอร์
- _Fork (ขั้นสูง):_ fork ไม่มี image ที่เผยแพร่ sidecar จึง fast-forward checkout ใน `RAKAZO_DEPLOY_DIR` แล้วรัน `up -d --build` ซึ่ง build บนเซิร์ฟเวอร์และใช้เวลาเป็นนาทีแทนที่จะเป็นวินาที ชี้ไปเฉพาะ fork ที่คุณควบคุมและตรวจแล้ว เพราะ sidecar รันไฟล์ Compose นั้นผ่าน Docker socket ที่มีสิทธิ์เทียบเท่า root

การอัปเดตและ rollback ทำทีละครั้ง pull ที่ล้มเหลวจะไม่แตะบริการที่รันอยู่ recreate ที่ล้มเหลวจะคืนค่าตรึงในสภาพแวดล้อมเดิมและพยายาม deploy image เดิมที่ cache ไว้ build ของ fork ที่ล้มเหลวยังคืน branch และ commit ก่อนอัปเดตด้วย (รวมกรณีที่ checkout สำเร็จแต่ merge ไม่สำเร็จ) การ `--build` ด้วยมือภายหลังจึง deploy revision ที่ถูกปฏิเสธหรือไม่ได้ตั้งใจไม่ได้ migration ของฐานข้อมูลไม่ถูกย้อนกลับ sidecar ไม่เคย recreate ตัวเอง ไม่แตะ Postgres หรือ Caddy และไม่รัน migration ลำดับนั้นเป็นหน้าที่ของการที่ API ขึ้นกับ service `migrate`

รับเฉพาะ git remote แบบ `https://` และ `ssh://` merge ทำได้เฉพาะแบบ fast-forward source tree ที่มีการแก้ไขหรือมีไฟล์ที่ไม่ได้ track จะล้มเหลวอย่างปลอดภัยก่อนรันอะไร (Dockerfile ของแอปใช้ `COPY . .`)

## อัปเดตรุ่นเสถียรตามกำหนดเวลา

ทั้ง production Compose และ `docker-compose.images.yml` ที่ไม่ต้องมี checkout มี profile `updater` แบบเลือกเปิด การเริ่ม profile นี้อย่างเดียว**ไม่ได้**เปิดการตั้งเวลา profile นี้ให้สิทธิ์ Docker เทียบเท่า root จึงควรปิดไว้ เว้นแต่ต้องการเครื่องมืออัปเดต

สำหรับการติดตั้งด้วย published images บน Linux ให้เพิ่มค่าเหล่านี้ใน `.env` ของเครื่อง:

```dotenv
COMPOSE_PROFILES=updater
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_AUTO_UPDATE_INTERVAL_HOURS=6
```

ใช้ path แบบเต็มของโฟลเดอร์ deploy จริงสำหรับ `RAKAZO_DEPLOY_DIR` path ของ Docker Desktop ต้องแปลงตามที่อธิบายด้านล่าง ตัวติดตั้งสร้าง `RAKAZO_UPDATER_TOKEN` ให้การติดตั้งใหม่ สำหรับการติดตั้งเก่า ให้เพิ่ม token เฉพาะโดยไม่พิมพ์ออกมา:

```bash
printf '\nRAKAZO_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

เก็บ token ที่มีอยู่ไว้ ถ้า stack ใช้ overlay ให้ตั้ง `RAKAZO_COMPOSE_FILE` เป็นรายการไฟล์ตามลำดับเดียวกับที่ใช้เอง เช่น `docker-compose.images.yml:docker-compose.override.yml` stack แบบ images จะ pull image ของ computer และ recreate stub สำหรับ pull แบบรันครั้งเดียวพร้อม supervisor เป็นค่าเริ่มต้น bot computer ที่มีอยู่ยังรันต่อ จากนั้นเริ่ม updater จากโฟลเดอร์ deploy:

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d updater
docker compose --env-file .env -f docker-compose.images.yml logs --tail 50 updater
```

สำหรับ source checkout ให้ใช้ไฟล์ production Compose ไม่ใช่ stack `docker-compose.yml` สำหรับ development ย้ายไปใช้ image ของแอปรุ่นเสถียรที่เผยแพร่ด้วยขั้นตอนอัปเดตด้วยมือด้านบนก่อนเปิดการตั้งเวลา image ที่รันอยู่ต้องตรงกับ image ของ source commit ที่ cache ไว้ image ที่ build จาก source หรือ override ซึ่งมีไบต์ต่างกันต้องย้ายด้วยมือ updater ไม่เคยกำหนดไบต์เหล่านั้นให้กับ release tag ที่เผยแพร่ร่วมกัน

จากนั้นเริ่ม updater ด้วย `-f infra/compose/docker-compose.prod.yml --profile updater` โดย build หรือ pull image ของมันอย่างชัดเจนตามที่อธิบายด้านบน อย่าเปิดการอัปเดตตามกำหนดเวลาบนเซิร์ฟเวอร์ที่ CI deploy จัดการอยู่แล้ว

การตรวจครั้งแรกรันหกชั่วโมงหลังเริ่ม จากนั้นหกชั่วโมงหลังการตรวจแต่ละครั้งเสร็จ ช่วงเวลาที่ใช้ได้คือ 1–168 ชั่วโมงเต็ม `0` ปิดการตั้งเวลา การตรวจใช้เฉพาะ tag `vX.Y.Z` รุ่นเสถียรล่าสุดของ repository ทางการ แปลงเป็น image tag ของ source commit เต็ม และใช้เส้นทาง apply/health-check/recovery ที่มีอยู่ prerelease และ build ของ main ไม่เคยถูกตั้งเวลา การตั้งเวลาถูกปิดสำหรับ image repository ที่กำหนดเอง พร้อมคำเตือนตอนเริ่มและ `autoUpdateDisabledReason` ใน `/state` ตัวควบคุมด้วยมือยังใช้ได้สำหรับ deployment ที่ใช้ repository เหล่านั้นอยู่แล้ว การเปลี่ยน repository ของ computer เป็นการย้ายที่ผู้ดูแลระบบต้องจัดการเอง: recreate supervisor ด้วย repository ใหม่และตรวจ image ที่ตรงกันก่อนใช้ตัวควบคุมของ updater updater ปฏิเสธเมื่อ repository ที่ตั้งไว้ไม่ตรงกับ supervisor ที่รันอยู่
ถ้าเป็นเวอร์ชันล่าสุดอยู่แล้ว จะไม่ recreate อะไร
การตรวจครั้งแรกอาจปรับค่าที่เลือก `latest` ให้เป็น tag ของ release commit เต็มแม้ไบต์ของ image จะตรงกัน ซึ่งตรึง computer ในอนาคตของ supervisor ไว้กับ release นั้น การตรวจครั้งถัดไปจะไม่ recreate บริการตราบที่ค่าที่เลือกยังเป็นปัจจุบัน
การตรวจแต่ละครั้งตรวจ image repository ของ deployment ใหม่ การอัปเดตที่กำลังรันจะใช้ repository ที่ตรวจแล้วนั้นสำหรับการ pull, recreate, กู้คืน และเก็บกวาด
การอัปเดตตามกำหนดเวลาติดตาม source commit รุ่นเสถียร ไม่ใช่การเปลี่ยน digest ใน registry การ build หรือเผยแพร่ image ใหม่สำหรับ source commit เดิมไม่ทำให้เกิดการ deploy ให้เผยแพร่ release เสถียรใหม่จาก commit ใหม่เพื่อปล่อยการเปลี่ยนแปลงของ image เหล่านั้นอัตโนมัติ
การตรวจที่ล้มเหลวจะเขียนสถานะการกู้คืน คำแนะนำการกู้คืน และข้อมูลวินิจฉัยของขั้นที่ล้มเหลวลง log แล้วตรวจอีกครั้งหลังช่วงเวลาที่ตั้งไว้ ไม่มีการลองใหม่ถี่ ๆ
updater รอให้การอัปเดตตามกำหนดเวลาที่กำลังทำงานเสร็จระหว่างปิดตัวอย่างนุ่มนวล

สำหรับ stack แบบ published images image ของแอปและ computer ถูกตรึงไว้กับ tag `sha-<commit>` เต็มของ release เดียวกัน updater pull ทั้งสองก่อน recreate บริการ release ที่ image ของ computer ยังเผยแพร่ไม่เสร็จจึงไม่แตะบริการที่รันอยู่ bot computer ใหม่ใช้ image ที่ตรึงไว้นั้น ไม่ใช่ cache `computer:latest` ที่เลื่อนได้ bot computer ที่มีอยู่ยังรันต่อ ค่าตรึงของ computer ปัจจุบันและก่อนหน้าถูกบันทึกไว้คู่กับค่าตรึงของแอป และ rollback คืนค่าพร้อมกันโดยไม่ติดต่อ registry
stub ของ computer ใช้ `pull_policy: missing` การ pull ปกติและการรันตัวติดตั้งซ้ำจึงใช้ image สำหรับ rollback ที่ cache ในเครื่องซ้ำ หลังอัปเดตสำเร็จ การเก็บกวาดจะลบ image release ของแอปและ computer ที่ล้าสมัยและ cache tag ของ computer โดยเก็บ image ปัจจุบัน/ก่อนหน้า cache หรือ tag ของผู้ดูแลระบบ image ที่คอนเทนเนอร์ใช้ และ image ที่ supervisor ที่รันอยู่เลือกไว้
การเก็บกวาด image อัตโนมัติจะถูกข้ามเมื่อมีคอนเทนเนอร์ของ project อื่นหรือของ stack ที่ไม่มี label อยู่
bot computer ที่จัดการอยู่ไม่ทำให้การเก็บกวาดถูกปิด Docker เก็บทุก image ที่คอนเทนเนอร์ที่รันอยู่หรือหยุดอยู่ใช้
เครื่องที่ใช้ร่วมกันต้องให้ผู้ดูแลระบบจัดการการเก็บ image เอง เพราะค่าตรึง rollback ของ stack อื่นอนุมานจาก image ที่รันอยู่ไม่ได้

ก่อนเปลี่ยนค่าตรึง updater ตรวจแอปที่รันอยู่เทียบกับ image ของ source commit ในเครื่อง และ pull baseline นั้นจาก registry ถ้าไม่ได้ cache ไว้
ถ้า runtime ของแอปและ reference ของ computer ที่จัดการอยู่ตรงกับ release แล้ว ค่าตรึงใน Compose ที่ล้าสมัยจะถูกปรับให้ตรงโดยไม่ต้อง deploy การกู้ image ตามกำหนดเวลาจะลองเฉพาะจาก release ก่อนหน้าที่ต่างกันและสม่ำเสมอ การซ่อม release ปัจจุบันที่ล้มเหลวหรือ runtime ที่ปนกันต้องแก้ด้วยมือ การลองเป้าหมายที่ล้มเหลวซ้ำไม่ถือว่าเป็นการคืนค่า release ก่อนหน้า การกู้ image ไม่เคยย้อน migration ของฐานข้อมูล

ถ้าจะหยุดการตั้งเวลาชั่วคราว ให้ตั้ง `RAKAZO_AUTO_UPDATE_INTERVAL_HOURS=0` ใน `.env` แล้วรันคำสั่ง `up -d updater` เดิม ตั้งกลับเป็น `6` แล้ว recreate updater เพื่อเริ่มต่อ หยุดชั่วคราวก่อน rollback ด้วยมือ ไม่อย่างนั้นการตรวจตามกำหนดครั้งถัดไปจะ apply release ที่ใหม่กว่าอีกครั้ง `/state` รายงาน `autoUpdateIntervalHours` พร้อมผลการอัปเดตล่าสุด endpoint `/apply` และ `/rollback` ที่มีอยู่ยังใช้ได้แม้ปิดการตั้งเวลา

stack แบบ images ไม่เปิด port ของ updater และไม่ route control API ผ่าน API ของแอป รันคำสั่งเหล่านี้จากโฟลเดอร์ deploy เพื่อเรียก updater **ภายใน**คอนเทนเนอร์ updater คำสั่งอ่าน token จากสภาพแวดล้อมของคอนเทนเนอร์โดยไม่พิมพ์ออกมาหรือใส่ใน argument ของคำสั่ง:

```bash
# Inspect the schedule and last update result.
docker compose --env-file .env -f docker-compose.images.yml exec -T updater node -e '
fetch("http://127.0.0.1:7092/state", {
  headers: {authorization: "Bearer " + process.env.RAKAZO_UPDATER_TOKEN}
}).then(async response => {
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });'

# After pausing scheduling as described above, restore the previous cached application image.
docker compose --env-file .env -f docker-compose.images.yml exec -T updater node -e '
fetch("http://127.0.0.1:7092/rollback", {
  method: "POST",
  headers: {authorization: "Bearer " + process.env.RAKAZO_UPDATER_TOKEN}
}).then(async response => {
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || result.ok === false) process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });'
```

ถ้าจะอัปเดตรุ่นเสถียรด้วยมือด้วยคำสั่งที่สอง ให้เปลี่ยน path เป็น `/apply` เพิ่ม `"content-type": "application/json"` ใน headers และเพิ่ม `body: JSON.stringify({repoUrl: "https://github.com/elie222/rakazo", branch: "main"})` ใน option ของ fetch repository ทางการยังเลือก release เสถียร `main` ตรงนี้ไม่ได้เลือก image ที่ build จาก main ให้ profile updater รันอยู่โดยตั้งช่วงเวลาเป็น `0` ถ้าต้องการใช้เฉพาะตัวควบคุมด้วยมือเหล่านี้ `/apply` ที่ผู้ดูแลระบบสั่งเองไม่ผ่านด่านตรวจ source รุ่นเสถียรของตัวตั้งเวลา จึงควรอ่าน release notes และตรวจความเข้ากันได้ของฐานข้อมูลก่อนย้าย build แบบ edge หรือที่ไม่รู้จักไปเป็นรุ่นเสถียรด้วยมือ อ่านคำแนะนำการกู้คืนในผลลัพธ์ถ้าการอัปเดตหรือ rollback ล้มเหลว ทั้งสองอย่างไม่ย้อน migration ของฐานข้อมูล

การอัปเดตแอปไม่ได้แทนที่ตัว updater เอง ไฟล์ Compose เวอร์ชันหลักของ Postgres หรือคอนเทนเนอร์ bot computer ที่มีอยู่ อ่าน release notes เพื่อดูการเปลี่ยนแปลงที่ต้องตั้งค่าด้วยมือ และเก็บ backup ฐานข้อมูลไว้: การกู้ image ของแอปไม่เคยย้อน migration ของฐานข้อมูล
การตั้งเวลาตรวจ source commit ของทุกบริการแอปที่รันอยู่ในแผนการอัปเดต เทียบกับ release tag เสถียรทางการ ก่อน pull หรือ recreate อะไร API ที่เป็นปัจจุบันตัวเดียวไม่พอ: บริการอื่นที่ล้าสมัยหรือหายไปจะถูกปรับให้ตรง โดยคงค่าตรึง release ก่อนหน้าไว้เมื่อ release ที่เลือกไม่เปลี่ยน build แบบ `edge`, prerelease หรือที่ไม่รู้จัก จะไม่ถูกแทนที่ด้วย release เสถียรที่เก่ากว่าโดยอัตโนมัติ แม้จะแก้ `.env` ให้เป็น `latest`
การติดตั้งแบบ edge ที่มีอยู่ต้องอ่าน release notes และย้ายไป release เสถียรที่เข้ากันได้ด้วยมือก่อนที่การตั้งเวลาจะทำงานต่อได้ trigger การ deploy ของ Cloud CI ไม่เปลี่ยน

## deploy directory ต้องเป็น path เดียว

`RAKAZO_DEPLOY_DIR` ถูก bind mount เข้า updater ที่ path เดียวกับที่อ่านมา (`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`) และเรื่องนี้จำเป็นต่อการทำงาน ไม่ใช่แค่ความเรียบร้อย production Compose ตั้งทั้งสองฝั่งเป็น `/srv/rakazo` เป็นค่าเริ่มต้น ตั้งตัวแปรนี้สำหรับโครงสร้างอื่น เมื่อ updater รัน `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d` Compose CLI *ภายใน*คอนเทนเนอร์จะขยาย bind mount แบบ relative ของไฟล์นี้ (`../../.env`, `./Caddyfile.prod`) เทียบกับ path นั้น แล้วส่งผลให้ daemon daemon ต้อง resolve string เดียวกันได้ ไม่อย่างนั้นจะสร้างโฟลเดอร์ว่างเงียบ ๆ ในที่ที่ควรเป็น `.env` และ Caddyfile ของคุณ Compose ให้ใช้ค่า `-p` ที่มีผลใน interpolation ได้ แต่ไม่ใส่ลงในสภาพแวดล้อมของคอนเทนเนอร์อัตโนมัติ ไฟล์ production จึงกำหนด `COMPOSE_PROJECT_NAME` ให้ updater อย่างชัดเจน sidecar ที่รันเดี่ยวตั้ง `RAKAZO_COMPOSE_PROJECT_NAME` แทนได้ ค่าสำรองสุดท้ายคือ `rakazo-prod` ถ้าไม่ส่งค่านี้ต่อ stack ที่เริ่มด้วย `-p something-else` จะถูกปล่อยไว้ ขณะที่ project ที่สองพร้อม volume Postgres ว่างใหม่ขึ้นมาข้าง ๆ

ค่านี้จึงต้องเป็น path ที่ **daemon** เห็น ซึ่งไม่ใช่ path ที่ shell ของคุณเห็นเสมอไป:

- **Linux** daemon ใช้ filesystem ร่วมกับเครื่อง path ของ checkout จึงเป็นคำตอบ: `/srv/rakazo` เป็นค่าเริ่มต้นและโครงสร้าง production ที่รองรับ ตั้ง `RAKAZO_DEPLOY_DIR` อย่างชัดเจนเมื่อ checkout อยู่ที่อื่น
- **Docker Desktop (Windows/macOS)** daemon รันใน VM ที่ mount drive ของคุณไว้ที่อื่น บน Windows `C:` อยู่ที่ `/run/desktop/mnt/host/c` checkout ที่ `C:\Users\you\rakazo` จึงเป็น `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo` Git บนเครื่องอาจใช้ `core.autocrlf=true` updater ไม่สน diff ที่ต่างกันแค่ CR จึงไม่ขวาง `/apply` ตรวจ mount ก่อน deploy:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater \
  sh -c 'git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1'
```

คำสั่งนี้ต้องพิมพ์ HEAD ของ checkout คุณ คำตอบผิดที่ดูน่าใช้ทั้งสองแบบล้มเหลว: path แบบ Windows native ถูก daemon ปฏิเสธ (`mount denied: … too many colons` เพราะ colon ของอักษร drive ชนกับตัวคั่น bind mount) และ `/mnt/c/...` ล้มเหลว*แบบเงียบ*: คอนเทนเนอร์เริ่มได้ mount เป็นโฟลเดอร์ว่าง และ updater แค่รายงานว่าไม่มี checkout

## Deployment ที่ซ้อนไฟล์ Compose overlay

`RAKAZO_COMPOSE_FILE` รับรายการที่คั่นแบบเดียวกับ `COMPOSE_FILE` ของ Compose (`:` เป็นค่าเริ่มต้น หรือตามที่ `COMPOSE_PATH_SEPARATOR` กำหนด) แต่ละรายการกลายเป็น `--file` ของตัวเองตามลำดับที่ให้ updater จึงปรับ stack เดียวกับที่ผู้ดูแลระบบรันเองให้ตรง:

```
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

แต่ละรายการถูกตรวจแยกกันและต้องอยู่ภายใน `RAKAZO_DEPLOY_DIR`

ถ้า overlay เพิ่ม service ที่ build จาก image ของแอป ให้ใส่ชื่อใน `RAKAZO_UPDATE_SERVICES` (คั่นด้วยจุลภาค) เพื่อให้ถูก pull, recreate และ rollback พร้อมตัวอื่น ไม่อย่างนั้นการอัปเดตจะปล่อยให้ service นั้นรันโค้ดเดิม:

```
RAKAZO_UPDATE_SERVICES=supervisor
```

ชื่อเหล่านี้ถูกต่อท้าย `api`, `worker`, `web` ที่มีในตัว ไม่ได้แทนที่ ค่าตรงนี้จึงตัด service หลักออกจากการอัปเดตไม่ได้

## สิทธิ์ของ updater

updater ถือ Docker socket ซึ่งมีสิทธิ์เทียบเท่า root บนเครื่อง จึงถูกจำกัดให้แคบที่สุดเท่าที่ทำได้:

- ไม่มี `ports` จึงไม่มีอะไรเปิดบนเครื่อง
- อยู่เฉพาะบนเครือข่าย `control` ที่ใช้ร่วมกับ API Caddy ไม่ได้เชื่อมอยู่ reverse proxy จึงไม่มีเส้นทางไปยัง updater
- ทุก route ยกเว้น `/health` ต้องใช้ bearer token ที่ใช้ร่วมกัน ซึ่งเปรียบเทียบแบบ constant time
- สภาพแวดล้อมของ process มีเฉพาะค่าของ updater (`RAKAZO_UPDATER_TOKEN`, path ของ deploy, ชื่อ image, ชื่อ project) secret ของแอปอยู่ใน `.env` ที่ bind mount ไว้ ซึ่ง Compose อ่านเพื่อ interpolation และไม่ถูกโหลดเข้าคอนเทนเนอร์นี้
- Docker CLI อยู่เฉพาะใน image ของ updater คอนเทนเนอร์ api, worker และ web ยังคง `cap_drop: ALL` และไม่มี socket

การเปิด profile `updater` ต้องให้ `RAKAZO_UPDATER_TOKEN` เป็นค่าสุ่มเฉพาะ (อย่างน้อย 32 ตัวอักษรใน production) และต้องต่างจาก `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN` และ `SCREEN_PROXY_SECRET` ปิด profile ไว้ถ้าไม่ต้องการให้สิทธิ์นี้
