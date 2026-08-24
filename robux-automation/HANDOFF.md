# Төслийг хүлээлгэн өгөх

Энэ файл нь төслийг шинэ эзэмшигч рүү шилжүүлэх зааварчилгаа. Хоёр хэсэгтэй:
**одоогийн эзэмшигч** юу дамжуулах вэ, **шинэ эзэмшигч** юу хийх вэ.

---

## 1. Git-д юу байгаа вэ

Repo дотор deploy хийхэд шаардлагатай бүх зүйл байгаа:

| Юу | Хаана |
| --- | --- |
| Аппын бүх код | `src/`, `public/`, `api/`, `server.js` |
| Өгөгдлийн сангийн schema | `src/models/schema/` — `npm run migrate` энэ бүхнийг үүсгэнэ |
| Vercel-ийн тохиргоо | `vercel.json` (functions, rewrites, cron) |
| Орчны хувьсагчдын жагсаалт | `config/.env.example` — түлхүүр бүр яагаад хэрэгтэйг тайлбарласан |
| Deploy-ийн заавар | `README.md` → «Vercel дээр байршуулах» |
| Хуучин SQLite өгөгдлийг зөөх скрипт | `scripts/import-sqlite.js` |

Шинэ эзэмшигч энэ repo-г clone хийгээд, доорх 3-р хэсгийг дагавал ажиллана.

## 2. Git-д юу БАЙХГҮЙ вэ, яагаад

Дараах зүйлс зориудаар `.gitignore`-т орсон бөгөөд **git-ээр дамжуулах
боломжгүй**:

| Юу | Яагаад |
| --- | --- |
| `config/.env`, `.env.local` | Нууц түлхүүрүүд. Git-д нэг л удаа орвол түүхэнд үлдэх тул бүгдийг нь дахин үүсгэх шаардлагатай болно |
| Өгөгдлийн сан (Neon Postgres) | Git-д багтдаггүй амьд сервер. Бодит захиалга, хэрэглэгчийн бүртгэл агуулдаг |
| `src/models/robux.db` | Хуучин SQLite. Бодит хэрэглэгчийн бүртгэлтэй |
| `uploads/receipts/` | Хэрэглэгчдийн банкны баримт. Production дээр Vercel Blob дотор байдаг |
| `.vercel/` | Одоогийн эзэмшигчийн Vercel project-той холбогдсон линк. Шинэ эзэмшигч өөрийнхөө project үүсгэнэ |

Эдгээрийг git-ээр биш, **тусад нь шууд дамжуулна** (доорх 2.1).

### 2.1 Дамжуулах зүйлсийн жагсаалт

Нууц утгуудыг чат/имэйлээр бус, нууц үг хуваалцах хэрэгсэл (1Password,
Bitwarden Send, эсвэл биечлэн) ашиглан дамжуулна.

**Заавал дамжуулах:**

- [ ] `CREDENTIAL_KEY` — **өгөгдлийн сангаа хуулж өгөх бол зайлшгүй.** Bot
      аккаунтын `.ROBLOSECURITY` cookie болон 2FA seed-ийг энэ түлхүүрээр
      шифрлэсэн байдаг. Түлхүүр өөрчлөгдвөл хуулсан өгөгдөл дэх bot-ийн
      мэдээлэл задрахгүй (`src/services/credentials.js`). Хэрэв дамжуулахгүй
      бол шинэ эзэмшигч `/admin.html` дээрээс bot-оо дахин холбож, 2FA seed-ээ
      дахин оруулах шаардлагатай.
- [ ] `ROBLOX_OAUTH_CLIENT_ID`, `ROBLOX_OAUTH_CLIENT_SECRET` — Roblox Creator
      Dashboard дээрх OAuth апп. Эсвэл шинэ эзэмшигч өөрийн аппаа үүсгэнэ.
- [ ] `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_SELLER_USER_ID` — худалдагч
      аккаунттай холбоотой.
- [ ] `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE` — QPay merchant
      бүртгэл. Merchant бүртгэл нэр дээр нь байдаг тул QPay-тэй холбоо барьж
      шилжүүлэх эсэхийг тодруулна.
- [ ] Bot аккаунтын нэвтрэх мэдээлэл (Roblox аккаунт өөрөө).
- [ ] Банкны дансны мэдээлэл (`/admin.html` дотор тохируулагддаг).
- [ ] Домэйн — DNS-ийг шинэ Vercel project руу заана.

**Дамжуулах шаардлагагүй** (шинэ эзэмшигч шинээр үүсгэнэ):

- `SESSION_SECRET` — шинээр үүсгэнэ (бүх хэрэглэгч нэг удаа гарна).
- `CRON_SECRET` — шинээр үүсгэнэ.
- `DATABASE_URL` — өөрийн Neon сан.
- `BLOB_READ_WRITE_TOKEN` — Blob store үүсгэхэд автоматаар нэмэгдэнэ.

---

## 3. Шинэ эзэмшигчийн алхмууд

### 3.1 Repo-г clone хийх

```powershell
git clone https://github.com/ByambaaNull/rbx.git
cd rbx/robux-automation
npm install
```

### 3.2 Postgres үүсгэх

[Neon](https://neon.tech) дээр (эсвэл Vercel → Storage → Neon Postgres) сан
үүсгээд connection string-ийг хуулна. `?sslmode=require` заавал байна.

### 3.3 Vercel project үүсгэх

```powershell
npm i -g vercel
vercel link          # шинэ project үүсгэнэ
```

Дараа нь Vercel dashboard → **Storage** → **Create Blob store**. Энэ нь
`BLOB_READ_WRITE_TOKEN`-ийг автоматаар орчны хувьсагч болгоно.

### 3.4 Орчны хувьсагчдыг тохируулах

`config/.env.example`-ийг хуулж аваад бүх түлхүүрийг бөглөнө:

```powershell
cp config/.env.example config/.env
```

Шинээр үүсгэх хоёр түлхүүр:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # CRON_SECRET
```

Дараа нь Vercel project → **Settings** → **Environment Variables** дотор
бүгдийг оруулна. Анхаарах гурван зүйл:

1. `DATABASE_URL`-ийг **Build** орчинд бас идэвхжүүлнэ — schema нь build
   дээр үүсдэг.
2. `NODE_ENV=production`. Үүнгүйгээр `SESSION_SECRET`, `CREDENTIAL_KEY`
   шалгалт ажиллахгүй.
3. `ROBLOX_OAUTH_REDIRECT_URI`-г шинэ домэйнд тааруулна
   (`https://<домэйн>/auth/roblox/callback`), мөн Roblox Creator Dashboard
   дээр ижил хаягийг бүртгэнэ. Хоёулаа таарахгүй бол нэвтрэлт ажиллахгүй.

### 3.5 Deploy

```powershell
npx vercel --prod
```

`vercel-build` script нь `npm run migrate`-ийг ажиллуулж schema-г үүсгэнэ.

### 3.6 Өгөгдлийг зөөх (хуучин захиалга байгаа бол)

Хуучин эзэмшигчийн Neon сангаас шинэ рүү:

```powershell
# Хуучин эзэмшигч дээр — dump гаргана
pg_dump "postgresql://ХУУЧИН-CONNECTION-STRING" --no-owner --no-acl -Fc -f rbx-backup.dump

# Шинэ эзэмшигч дээр — schema-г эхлээд үүсгээд сэргээнэ
$env:DATABASE_URL="postgresql://ШИНЭ-CONNECTION-STRING"
npm run migrate
pg_restore --no-owner --no-acl --data-only -d "$env:DATABASE_URL" rbx-backup.dump
```

Хэрэв өгөгдөл нь SQLite (`src/models/robux.db`) дотор л байгаа бол:

```powershell
$env:DATABASE_URL="postgresql://ШИНЭ-CONNECTION-STRING"
npm run migrate
node scripts/import-sqlite.js --dry-run   # эхлээд юу хуулагдахыг харна
node scripts/import-sqlite.js
```

`rbx-backup.dump` файл нь бодит хэрэглэгчийн өгөгдөл тул зөөж дуусмагц устгана.

**Баримтууд:** хуучин Blob store доторх төлбөрийн баримтууд шинэ store руу
автоматаар шилждэггүй. Шаардлагатай бол хуучин эзэмшигч Vercel Blob-оос
татаж авч дамжуулна.

### 3.7 Deploy-ийн дараа шалгах

- [ ] Storefront нээгдэж байна.
- [ ] Roblox-оор нэвтрэлт ажиллаж байна (redirect URI таарсан).
- [ ] `/admin.html` руу нэвтэрч байна.
- [ ] Bot аккаунт холбогдсон — `npm run diagnose:group` алдаагүй.
- [ ] Туршилтын захиалга үүсгээд төлбөр→хүргэлт хүртэл явж үзнэ.
- [ ] Cron ажиллаж байна: Vercel → Deployment → Cron Jobs.

---

## 4. Тарифын анхааруулга

`vercel.json` дотор cron өдөрт нэг удаа (`0 3 * * *`) ажиллахаар тохируулсан —
**Hobby тариф cron-ыг өдөрт нэг л удаа ажиллуулдаг**. Энэ нь группын захиалга
өдөрт нэг удаа хүргэгдэнэ гэсэн үг: техникийн хувьд ажиллаж байгаа ч
худалдан авагчийн хувьд хүлээх хугацаа хэт урт.

Хоёр сонголт:

- **Pro тариф** авч `schedule`-ийг `* * * * *` болгох.
- Урт хугацаанд ажилладаг хост (Railway, Render, Fly.io) дээр `npm start`-аар
  асаах — доторх poller 90 секунд тутам өөрөө ажиллана, cron хэрэггүй.
