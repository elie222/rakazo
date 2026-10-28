# Payments

Bots can buy things with their user's wallet. Each user connects their own wallet, and every purchase asks them to approve it in the wallet provider's app or page before any card or token exists. Card numbers, security codes and payment tokens go straight to the merchant; they never reach the model, chat history, tool results, or logs.

The default is `PAYMENT_WALLET_PROVIDER=none`. Core workflows do not require a wallet, and with none configured users see nothing related to payments.

## Enable Link

Configure the API and worker with the same values:

```dotenv
PAYMENT_WALLET_PROVIDER=link
# Optional. Defaults to Link's public sign-in client.
PAYMENT_WALLET_CLIENT_ID=
```

Users then see a Link connect button in Settings. Connecting opens Link's sign-in page with a code to confirm. Once connected, bots get `request_purchase`, `purchase_status` and `paid_request`. Each request names the amount and reason; the user approves or denies it in Link.

Link is available to users in the US and Canada only.

Unknown or blank values fall back to `none` instead of failing at boot.

## How a purchase is paid

- **Card.** Approval issues a single-use card. The bot types it into the checkout on the purchase's own HTTPS origin, in the page or in a known payment provider's frame on it.
- **Pay token.** A Stripe checkout that accepts Link pay tokens says so in the page snapshot, with its merchant account. The bot requests the purchase for that account, and after approval hands the token to the checkout, which then shows the user's saved Link card. Tokens expire 30 minutes after approval.
- **Paid HTTP requests.** `paid_request` sends an HTTPS request. If the server answers `402 Payment Required` with a Machine Payments Protocol challenge for Stripe, the amount comes from the challenge and the user approves it; the bot then sends the request again and it carries the payment. Other payment methods are never paid. The request is stored encrypted until it is sent, it may not carry credentials or cookies, and redirects are reported instead of followed. A payment token is used once; a refused paid request needs a new approval.

## Disconnecting

Disconnecting in Settings revokes the connection with the provider. If the provider revokes it first (for example, the user signs out of the connection in Link), purchase tools stop working until the user connects again.

## Offline verification

`PAYMENT_WALLET_PROVIDER=emulator` runs an in-process wallet for development and tests. Sign-in completes immediately; purchases are approved on the next status check, and amounts above 1,000.00 are denied. It fills the test card `4242 4242 4242 4242`, issues fake pay tokens, and pays Stripe challenges in 402 responses with a fake token. A shared conformance suite runs against the emulator and against the Link adapter backed by a fake Link API and a fake paid API, without network calls.
