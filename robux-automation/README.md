# RBX / Улаанбаатар

MNT үнэтэй Robux захиалгын storefront болон админ дараалал. Хэрэглэгч Roblox OAuth 2.0-оор нэвтэрч, тогтмол багцаас сонгож, дотоодын банкны шилжүүлгээр төлнө. Админ төлбөрийг баталгаажуулсны дараа Robux хоёр замын аль нэгээр хүргэгдэнэ.

Нууц үг болон `.ROBLOSECURITY` cookie хэрэглэгчээс **хэзээ ч** авахгүй. Roblox-ийн албан ёсны OAuth 2.0 (PKCE) л ашиглана.

## Асаах

```powershell
npm install
node server.js 3000
```

Дараа нь `http://localhost:3000` хаягийг нээнэ.

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
| `TRUST_PROXY_HOPS` | Урд талд хэдэн reverse proxy байгаа (nginx = 1, Cloudflare + nginx = 2). Rate limit болон audit log `req.ip`-ээс хамаардаг тул буруу утга нь бүх хэрэглэгчийг нэг IP болгоно. |
| `ROBLOX_OAUTH_CLIENT_ID` / `_SECRET` | Roblox Creator Dashboard > OAuth 2.0 Apps |
| `ROBLOX_OAUTH_REDIRECT_URI` | Яг `<домэйн>/auth/roblox/callback` байна |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Seller-ийн Game Pass эзэмшлийг шалгах Inventory API |
| `ROBLOX_SELLER_USER_ID` | Seller аккаунтын Roblox user ID |
| `QPAY_USERNAME` / `_PASSWORD` / `_INVOICE_CODE` | Автомат төлбөр баталгаажуулалт. Хоосон бол гар аргын банкны урсгал үлдэнэ |
| `DATABASE_PATH` | Өгөгдлийн сангийн байршлыг солино. Тавихгүй бол `src/models/robux.db`. Зөвхөн тест болон хоёр дахь instance-д хэрэгтэй |

### Roblox OAuth тохиргоо

1. Roblox Creator Dashboard-ийн **OAuth 2.0 Apps** хэсэгт апп үүсгэнэ.
2. `openid`, `profile`, `game-pass:write` scope-уудыг нэмнэ.
3. Redirect URL дээр яг `http://localhost:3000/auth/roblox/callback` нэмнэ.
4. Серверээ дахин асаана.

OAuth access token SQLite-д бичигдэхгүй. Богино настай token зөвхөн тухайн browser session-д хадгалагдана.

Утаснаас QR уншуулах production урсгалд утаснаас нээгдэх боломжтой HTTPS callback домэйн хэрэгтэй. Утас дээрх `localhost` нь компьютерийг биш тухайн утсыг заадаг.

### Bot аккаунт (группын хүргэлтэд)

Группын payout ашиглах бол `/admin.html` дээрээс bot аккаунтын `.ROBLOSECURITY` cookie болон группын ID-г оруулна. Bot нь группд элсэх хүсэлтийг зөвшөөрч, группын сангаас payout илгээнэ.

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
server.js                  # HTTP сервер асаана (порт, listener)
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
    connection.js          # SQLite холболт (нэг л газар). DATABASE_PATH-аар солино
    schema/                # Хүснэгт үүсгэх + migration, домэйн тус бүрээр
    repositories/          # Домэйн тус бүрийн query helper-ууд (16 файл)
    db.js                  # Композиц: бүгдийг нэг dbHelpers болгоно

public/
  index.html  admin.html  admin-login.html
  css/                     # Нэг сэдэв = нэг файл. Дарааллыг HTML дотор бичсэн
  js/
    common/                # dom · format · api · page (хоёр хуудсанд хуваалцана)
    storefront/            # Дэлгүүрийн модулиуд + main.js
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

## Тест

```powershell
npm test
```

8 suite: OAuth урсгал, үнийн тохиргоо, эвентийн цонх, payout аюулгүй байдал,
бэлгийн картын redemption, auth hardening, төлбөрийн тааруулалт, аюулгүй
байдлын header/rate limit.

Тест бодит өгөгдлийн санг хөндөхгүй байлгах бол `DATABASE_PATH`-аар түр файл
заана:

```powershell
$env:DATABASE_PATH="$env:TEMP\rbx-test.db"; npm test
```

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
