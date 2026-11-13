# RBX / Улаанбаатар

MNT үнэтэй Robux захиалгын storefront болон админ дараалал. Хэрэглэгч Roblox OAuth 2.0-оор нэвтэрч, тогтмол багцаас сонгож, дотоодын банкны шилжүүлгээр төлнө. Админ төлбөрийг баталгаажуулсны дараа Robux хоёр замын аль нэгээр хүргэгдэнэ.

Нууц үг  хэрэглэгчээс **хэзээ ч** авахгүй. 

Төслийг өөр эзэмшигч рүү шилжүүлж байгаа бол [HANDOFF.md](HANDOFF.md)-г үзнэ үү.

## Асаах

```powershell
npm install
node server.js 3000
```

Дараа нь `http://localhost:3000` хаягийг нээнэ.

Өгөгдлийн сангийн сервер суулгах шаардлагагүй: `DATABASE_URL` хоосон үед апп
**PGlite** ашиглана — WASM болгон хөрвүүлсэн жинхэнэ Postgres, процессын дотор
ажиллана. Production-тай яг ижил SQL диалект тул локалд ажилласан query
deploy хийсний дараа мөн ажиллана.

Анхдагчаар in-memory тул restart бүрт цэвэрхэн эхэлнэ. Локал өгөгдлөө хадгалах
бол `PGLITE_PATH=./.pglite` гэж заана.

Fresh database дээр анхны админыг нэг удаа үүсгэнэ:

```powershell
node src/utils/setup-admin.js admin "хамгийн-багадаа-12-тэмдэгт-нууц-үг"
```

Нэг админ үүссэний дараа public registration автоматаар хаагдана.

## Тохиргоо

`config/.env.example`-ийг `config/.env` болгон хуулж бөглөнө.

| Хувьсагч | Тайлбар |
| --- | --- |
| `SESSION_SECRET` | Session cookie-г гарын үсэглэнэ. **Production дээр заавал** — байхгүй бол сервер асахаас татгалзана. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CREDENTIAL_KEY` | Bot-ийн `.ROBLOSECURITY` cookie болон 2FA секретийг өгөгдлийн санд AES-256-GCM-ээр шифрлэнэ. **Production дээр заавал**. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `TRUST_PROXY_HOPS` | Урд талд хэдэн reverse proxy байгаа (nginx = 1, Cloudflare + nginx = 2). Rate limit болон audit log `req.ip`-ээс хамаардаг тул буруу утга нь бүх хэрэглэгчийг нэг IP болгоно. |
| `ROBLOX_OAUTH_CLIENT_ID` / `_SECRET` | Roblox Creator Dashboard > OAuth 2.0 Apps |
| `ROBLOX_OAUTH_REDIRECT_URI` | Яг `<домэйн>/auth/roblox/callback` байна |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Seller-ийн Game Pass эзэмшлийг шалгах Inventory API |
| `ROBLOX_SELLER_USER_ID` | Seller аккаунтын Roblox user ID |
| `QPAY_USERNAME` / `_PASSWORD` / `_INVOICE_CODE` | Автомат төлбөр баталгаажуулалт. Хоосон бол гар аргын банкны урсгал үлдэнэ |
| `DATABASE_URL` | Postgres холболтын мөр. **Production дээр заавал**. Хоосон бол PGlite (in-process Postgres) ажиллана — сервер суулгах шаардлагагүй |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token. Төлбөрийн баримт хадгална. **Vercel дээр заавал** — хоосон бол `uploads/receipts` рүү бичнэ |
| `CRON_SECRET` | `/api/cron/group-orders`-ийн нууц үг. **Vercel дээр заавал** — байхгүй бол хүргэлтийн sweep хэзээ ч ажиллахгүй |
| `SCHEMA_ON_BOOT` | `1` бол асах үед schema-г үүсгэнэ. Postgres дээр анхдагчаар унтраалттай (доорх тайлбарыг үзнэ үү) |
| `GAMEPASS_ROUTE_ENABLED` | `1` бол Game Pass (pending) зам нээгдэнэ |
| `GAMEPASS_MIN_AGE_RATING` | Хэрэглэгчийн тоглоомын шаардлагатай доод насны ангилал (default `16`). Тоглоом Public + энэ ангилалтай биш бол Game Pass үүсгэхгүй |
| `PGLITE_PATH` | PGlite-ийн өгөгдлийг файлд хадгална. Тавихгүй бол in-memory (тест бүр цэвэр сангаас эхэлнэ) |

### Roblox OAuth тохиргоо

1. Roblox Creator Dashboard-ийн **OAuth 2.0 Apps** хэсэгт апп үүсгэнэ.
2. `openid`, `profile`, `game-pass:write`, `universe:write` scope-уудыг нэмнэ (`universe:write` нь хэрэглэгчийн тоглоомыг автоматаар Public болгох туршилт).
3. Redirect URL дээр яг `http://localhost:3000/auth/roblox/callback` нэмнэ.
4. Серверээ дахин асаана.

OAuth access token SQLite-д бичигдэхгүй. Богино настай token зөвхөн тухайн browser session-д хадгалагдана.

Утаснаас нэвтрэх production урсгалд (шууд холбоос ч, QR ч ялгаагүй) утаснаас нээгдэх боломжтой HTTPS callback домэйн хэрэгтэй. Утас дээрх `localhost` нь компьютерийг биш тухайн утсыг заадаг.

### Bot аккаунт (группын хүргэлтэд)

Группын payout ашиглах бол `/admin.html` дээрээс bot аккаунтын `.ROBLOSECURITY` cookie болон группын ID-г оруулна. Bot нь группд элсэх хүсэлтийг зөвшөөрч, группын сангаас payout илгээнэ.

Cookie болон 2FA секрет хоёулаа `CREDENTIAL_KEY`-ээр шифрлэгдэж хадгалагдана. Түлхүүр солигдвол хуучин утга уншигдахгүй бөгөөд алдаа **чимээгүй** биш — bot-оо дахин холбоно.

#### Bot дээрх 2FA

Bot аккаунт дээр 2-step verification асаалттай бол Roblox payout хүсэлтийг 403-аар буцааж, `rblx-challenge-*` header-үүдээр код нэхнэ. Payout нь 90 секунд тутам ажилладаг background poller-оос явдаг тул хажууд нь код бичих хүн байхгүй — иймд `/admin.html` дээр authenticator-ийн base32 түлхүүрийг оруулна. Систем RFC 6238 TOTP кодыг өөрөө үүсгэж, challenge-ийг давж, анхны хүсэлтийг **яг нэг удаа** дахин илгээнэ.

**Аюулгүй байдлын солилцоо:** түлхүүр хадгалагдсанаар өгөгдлийн санд хүрсэн хүн bot-ийн 2FA-г давна. Өөрөөр хэлбэл 2FA нь энэ серверийг эвдсэн халдлагаас хамгаалахаа больж, зөвхөн өөр газраас нууц үг алдагдахаас хамгаална. Poller-ийг хүнгүй ажиллуулах бол өөр сонголт байхгүй.

2FA секрет байхгүй үед challenge гарвал захиалга **дараалалд буцна** — payout нь gate дээр татгалзсан тул Robux хөдлөөгүй нь баталгаатай. Админ түлхүүрээ оруулмагц дараагийн poll дээр хүргэгдэнэ.

### Банкны данс

`/admin.html` > **Данс** хэсэгт хэдэн ч данс нэмж болно. Захиалагч жагсаалтаас өөрийн банкийг сонгоод шилжүүлнэ — банк доторх шилжүүлэг шууд ордог тул interbank-ийн хүлээлт гарахгүй. Аль данс руу шилжүүлсэн нь ямар ч ялгаагүй: төлбөрийг захиалгатай холбодог зүйл нь зөвхөн `RBX-XXXXXX` гүйлгээний утга.

Дараалал нь захиалагчийн харах дараалал. Хаагдсан данс байвал **устгахын оронд идэвхгүй болгоно** — тэгвэл хуучин баримт дээрх данс нэртэйгээ үлдэнэ.

## Хүргэлтийн хоёр зам

Аль замаар хүргэхийг **сервер шийднэ** — client сонгохгүй (`GET /order/eligibility`).

**1. Group payout (автомат).** Худалдан авагч группд элсээд Roblox-ийн шаарддаг хугацаа (default 14 хоног) өнгөрсөн бол bot нь группын сангаас шууд payout илгээнэ. Background poller 90 секунд тутам шалгаж, боломжтой болмогц админы оролцоогүйгээр хүргэнэ.

**2. Game Pass (гар аргаар).** Хэрэглэгч өөрийн experience дээр Game Pass үүсгэх зөвшөөрөл өгнө. Апп `ceil(хүлээн авах Robux / 0.70)` томьёогоор Roblox-ийн 30% шимтгэлийг тооцсон үнээр бодит pass үүсгэнэ. Seller аккаунтаар худалдан авах албан ёсны API байхгүй тул эцсийн худалдан авалт **санаатайгаар manual** байна — админ Roblox дээрээс худалдаж аваад, **Roblox-оос шалгах** товчоор Inventory API-аар баталгаажуулна.

## Захиалгын урсгал

1. Хэрэглэгч Roblox OAuth-оор нэвтэрнэ (QR эсвэл шууд).
2. Утасны дугаараа холбоно (`/phone/link`) — захиалга үүсгэхийн өмнөх заавал шаардлага.
3. Тогтмол багцаас сонгоно. Үнэ, бонус, хямдрал бүгд **сервер тал дээр** бодогдоно.
4. Төлбөрийн код (`RBX-XXXXXX`) бүхий захиалга үүснэ. Энэ код нь банкны шилжүүлгийг захиалгатай холбох цорын ганц зүйл.
5. Хэрэглэгч банкны баримтаа зураг/PDF-ээр илгээнэ.
6. Админ `/admin.html` дээрээс баримтыг хараад төлбөрийг баталгаажуулна.
7. Дээрх хоёр замын аль нэгээр хүргэгдэнэ.

### Захиалгын төлөв

`awaiting_payment` → `payment_submitted` → `under_review` → `payment_approved` → `fulfillment_pending` → `fulfillment_processing` → `completed`

Төлөв бүр `transitionOrderStatus`-аар дамжина. Энэ нь `WHERE status IN (...)` хамгаалалттай UPDATE тул хоёр зэрэг дуудалт гарвал зөвхөн нэг нь ялна — нэг захиалга хоёр удаа хүргэгдэх боломжгүй.

**Чухал:** `fulfillment_processing` дээр гацсан захиалгыг систем **хэзээ ч автоматаар дахин оролдохгүй**. Payout аль хэдийн хүрсэн эсэх нь тодорхойгүй тул дахин илгээх нь хэрэглэгчид хоёр удаа төлөх зам юм. `/admin/orders/stalled` дээрээс админ Roblox-ийн ledger-тэй тулгаж шийднэ (систем нь `robloxSaysDelivered` талбараар хариултыг санал болгоно, гэхдээ шийдвэрийг админ гаргана).

## Бусад боломжууд

- **Бэлгийн карт** — тогтмол багцаар худалдаж авч, кодыг бусдад дамжуулна. Кодыг ашигласан хүн өөрийн холбогдсон аккаунт руугаа л авна.
- **Referral** — өөрийн код үүсгэж, найзаа урина. Bonus нь захиалга **бодитоор хүргэгдсэний дараа** л creator-т тооцогдоно.
- **Түвшин** — нийт худалдаж авсан Robux-аас хамаарсан хямдрал. Client-ээс биш, бодит захиалгын түүхээс бодогдоно.
- **Эвент** — хугацаатай бонус хувь.
- **Audit log** — админы үйлдэл бүр бичигдэнэ. Устгах/засах route зориудаар байхгүй.

## Аюулгүй байдал

- CSP (nonce-той, `unsafe-inline` байхгүй), HSTS, `frame-ancestors 'none'` — `src/middleware/security-headers.js`
- Rate limit 4 түвшинд: global, public data, login, write — `src/middleware/anti-scraping.js`
- Scraper хамгаалалт: known bot UA, Fetch Metadata, Origin шалгалт
- Session нь SQLite-д хадгалагдана; нэвтрэх бүрт session ID шинэчлэгдэнэ
- Баримт бичгүүд web root-оос **гадна** хадгалагдаж, зөвхөн админ route-аар уншигдана

`public/shield.js` нь devtools-ийг хааж **чадахгүй** — тэр нь зүгээр л саад. Бодит хамгаалалт нь бүхэлдээ сервер тал дээр байгаа. Дэлгэрэнгүйг тухайн файлын толгой хэсгээс уншина уу.

## Кодын бүтэц

Том файл бүрийг домэйнээр нь салгаж, композицоор нэгтгэсэн. Гадаад интерфэйс
өөрчлөгдөөгүй — зөвхөн дотоод хуваалт өөрчлөгдсөн. Аль ч файл ~450 мөрөөс
хэтрэхгүй.

```
server.js                  # HTTP сервер асаана (порт, listener) + хүргэлтийн poller
api/index.js               # Vercel-ийн entrypoint (poller асаахгүй — cron ашиглана)
vercel.json                # rewrite бүгдийг api/index рүү + cron хуваарь
scripts/
  migrate.js               # Schema-г үүсгээд гарна (deploy алхам)
  import-sqlite.js         # Хуучин robux.db-г Postgres руу нэг удаа хуулна
src/
  app.js                   # Express апп: middleware, static, fallback
  routes/
    index.js               # Композиц: controller-уудыг үүсгэж, бүлгүүдийг бүртгэнэ
    guards.js              # requireAuth болон нийтийн өгөгдлийн middleware гинж
    auth.js  storefront.js  account.js
    orders.js  gift-cards.js  payments.js
    admin/                 # session · queue · catalog · group · support
  controllers/
    admin/                 # auth · storefront · group · orders · catalog · support
    admin-controller.js    # Композиц: mixin-үүдийг нэг prototype дээр нэгтгэнэ
    <домэйн>-controller.js
  services/                # Бизнес логик (Roblox, QPay, үнэ, referral, түвшин)
  middleware/              # Аюулгүй байдлын header, rate limit, session store
  models/
    connection.js          # Postgres холболт (нэг л газар). DATABASE_URL / PGlite
    pg-adapter.js          # sqlite3-ийн callback API-г Postgres дээр хэрэгжүүлнэ
    db-errors.js           # DB алдааг SQLSTATE-ээр таних (23505 = давхцал)
    schema/                # Хүснэгт үүсгэх + migration, домэйн тус бүрээр
    repositories/          # Домэйн тус бүрийн query helper-ууд (17 файл)
    db.js                  # Композиц: бүгдийг нэг dbHelpers болгоно

public/
  index.html               # Нүүр: үнийн жагсаалт + гараас дүн оруулах
  giftcards.html  invite.html  faq.html  promos.html    # Танилцуулга хуудсууд
  app.html                 # Нэвтэрсэн хэсэг: захиалга, түүх, бэлгийн карт, урилга
  admin.html  admin-login.html
  css/
    main-menu.css          # Дизайн систем: өнгө, толгой, rail, панел, нэвтрэх цонх
    pages.css              # Танилцуулга хуудсуудын нэмэлт
    app.css                # Нэвтэрсэн хэсэг (JS-ээс гардаг class-уудыг мөн энд)
    tokens/base/…          # Зөвхөн админ самбар ашигладаг хуучин стек
  js/
    common/                # dom · format · api · page (бүх хуудас хуваалцана)
    storefront/
      shell.js             # Хуудас бүрийн толгой: хонх, Login, нэвтрэх цонх
      main-menu.js         # Нүүрний үнийн жагсаалт
      chrome.js            # Зөвхөн толгой хэрэгтэй хуудсууд (giftcards, faq)
      invite-page.js  promos-page.js
      app.js               # Нэвтэрсэн хэсгийн entry — модулиуд нь хуучнаараа
    admin/                 # Админ самбарын модулиуд + main.js
  shield.js                # Зөвхөн саад. Аюулгүй байдал биш (файлын толгойг уншина уу)
```

Frontend нь ES module ашигладаг (`<script type="module">`) — build алхам
байхгүй, browser өөрөө import-г шийднэ. Inline script үлдээгүй тул CSP-ийн
nonce-той хэсэг хамгийн бага байна.

`src/models/schema/index.js` дотор **дараалал чухал**: `settings` хүснэгт эхэлж
үүсэх ёстой, дараа нь түүнд default бичдэг файлууд орно.

Композиц root бүр **нэрийн давхцлыг boot дээр шалгадаг**. Хоёр repository
(эсвэл хоёр mixin) ижил нэртэй helper тодорхойлвол сервер асахгүй — чимээгүйгээр
буруу query ажиллахаас илүү нь шууд унасан нь дээр.

## Vercel дээр байршуулах

Апп SQLite файл дээр ажилладаг байсан. Vercel дээр тэр боломжгүй: serverless
функцийн файл систем хүсэлт бүрт шинээр үүсдэг тул нэг хүсэлтэд бичсэн захиалга,
төлбөр дараагийнхад алга болно. Тиймээс гурван зүйл гадагш гарсан:

| Юу | Хаана очсон |
| --- | --- |
| Өгөгдлийн сан | Postgres (Neon эсвэл Vercel Postgres) |
| Төлбөрийн баримт | Vercel Blob, `access: 'private'` — зөвхөн админы route-аар уншигдана |
| Хүргэлтийн poller | Vercel Cron → `/api/cron/group-orders` |

### 1. Postgres үүсгэх

[Neon](https://neon.tech) дээр сан үүсгээд connection string-ийг хуулна
(`?sslmode=require` -тэй). Vercel Postgres бол Storage табаас `POSTGRES_URL`.

### 2. Blob store үүсгэх

Vercel project → **Storage** → **Create Blob store**. `BLOB_READ_WRITE_TOKEN`
автоматаар орчны хувьсагч болно.

### 3. Орчны хувьсагчид

Vercel project → **Settings** → **Environment Variables**. `config/.env`-д
байгаа бүгдийг оруулаад, дараах гурвыг нэмнэ:

```
DATABASE_URL=postgresql://...        # Neon-ы connection string
BLOB_READ_WRITE_TOKEN=...            # Blob store үүсгэхэд автоматаар нэмэгдэнэ
CRON_SECRET=...                      # randomBytes(32).toString('base64url')
NODE_ENV=production
```

`DATABASE_URL`-ийг **Build** орчинд бас идэвхжүүлнэ — schema нь build дээр
үүсдэг (доороос үзнэ үү).

`ROBLOX_OAUTH_REDIRECT_URI`-г шинэ домэйнд тааруулж, Roblox Creator Dashboard
дээр мөн шинэчлэхээ мартуузай.

### 4. Deploy

```powershell
npx vercel --prod
```

`vercel-build` script нь `npm run migrate`-г ажиллуулж schema-г үүсгэнэ.

**Яагаад schema-г асах үед үүсгэдэггүй вэ:** cold start бүр 40 орчим
`CREATE TABLE` дахин илгээнэ, зэрэг эхэлсэн хоёр instance нэг нэгэндээ мөргөж
`pg_type` дээр duplicate key алдаа өгнө — тэр нь амьд хүсэлтийг унагаана.
Тиймээс migration нь deploy алхам болсон. Урт хугацаанд ажилладаг сервер дээр
`SCHEMA_ON_BOOT=1` тавибал хуучин байдлаараа ажиллана.

### 5. Хуучин өгөгдлөө зөөх

`src/models/robux.db` дотор бодит захиалга, хэрэглэгч байгаа бол:

```powershell
$env:DATABASE_URL="postgresql://..."
npm run migrate
node scripts/import-sqlite.js --dry-run   # эхлээд юу хуулагдахыг харна
node scripts/import-sqlite.js
```

Session-ы хүснэгтүүдийг зориудаар хуулдаггүй — тэдгээр нь нэг өдрийн дотор
хугацаа нь дуусдаг амьд нэвтрэлтийн төлөв.

Скрипт нь дуусахдаа id sequence-үүдийг тааруулна. Үүнгүйгээр дараагийн шинэ
бичлэг id 1-ийг дахин ашиглах гэж оролдоод primary key дээр унана.

### Cron-ы хуваарь ба тарифын хязгаар

`vercel.json` дотор sweep өдөрт нэг удаа ажиллахаар тохируулсан — Hobby
тарифын хязгаарт багтаах гэж (хуучин poller 90 секунд тутам байсан):

```json
"crons": [{ "path": "/api/cron/group-orders", "schedule": "0 3 * * *" }]
```

**Hobby тариф дээр cron өдөрт нэг л удаа ажиллана.** Тэр тохиолдолд группын
захиалга өдөрт нэг удаа хүргэгдэнэ — техникийн хувьд ажиллаж байгаа ч
худалдан авагчийн хувьд хүлээх хугацаа хэт урт. Минут тутмын хуваарь **Pro
тариф** шаардана. Хэрэв Pro авах бодолгүй бол урт хугacаанд ажилладаг хост
(Railway, Render, Fly.io) дээр `npm start`-аар асаавал доторх poller хэвээрээ
90 секунд тутам ажиллана.

`maxDuration` 60 секунд болгосон: sweep нь хүлээгдэж буй захиалга бүрээр
дараалан явж, тус бүрд Roblox руу хэд хэдэн хүсэлт тавьдаг.

## Тест

```powershell
npm test
```

10 suite: OAuth урсгал, үнийн тохиргоо, эвентийн цонх, payout аюулгүй байдал,
bot 2FA, банкны данс, бэлгийн картын redemption, auth hardening, төлбөрийн
тааруулалт, аюулгүй байдлын header/rate limit.

Тест бодит өгөгдлийн санг хөндөх боломжгүй: `DATABASE_URL` тавиагүй үед процесс
бүр өөрийн in-memory PGlite сангаар асдаг тул суурь нь үргэлж цэвэр байна.
Хуучин `DATABASE_PATH` хувьсагч байхгүй болсон.

## Гол endpoint-ууд

| Endpoint | Тайлбар |
| --- | --- |
| `GET /auth/qr` | PKCE authorization URL болон QR үүсгэнэ |
| `GET /auth/roblox/callback` | Authorization code-г баталгаажуулна |
| `GET /auth/status/:sessionId` | OAuth төлөв болон зөвшөөрсөн universe-үүд |
| `GET /packages` `/pricing` `/events` | Storefront-ийн нийтийн мэдээлэл |
| `GET /order/eligibility` | Энэ хэрэглэгч аль замаар авах вэ |
| `POST /create-group-order` | Группын payout захиалга |
| `POST /create-gamepass` | Roblox дээр бодит Game Pass үүсгэнэ |
| `POST /orders/:id/receipt` | Банкны баримт хавсаргана |
| `POST /gift-cards/redeem` | Бэлгийн карт ашиглана |
| `GET /admin/orders` | Захиалгын дараалал |
| `PUT /admin/orders/:id/payment-received` | MNT төлбөрийг баталгаажуулна |
| `PUT /admin/orders/:id/purchased` | Seller ownership-ийг шалгаад захиалгыг дуусгана |
| `GET /admin/orders/stalled` | Гацсан хүргэлтүүд + Roblox ledger-ийн хариу |
| `GET /admin/audit-log` | Админы үйлдлийн түүх |
