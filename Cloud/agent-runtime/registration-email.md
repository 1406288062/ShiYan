# Registration email delivery

Public registration and owner bootstrap require a six-digit email code. Existing account login and QR login do not change. Codes expire after 10 minutes, allow 5 incorrect guesses, and can be resent after 60 seconds. Codes are never returned by the API or stored in plaintext.

Configure the account sidecar with a protected environment file (mode 0600), loaded through its systemd user service EnvironmentFile. Do not put credentials into source files or mobile/desktop bundles.

To reuse the existing QQ mail integration, set only
`SHIYAN_SMTP_CONFIG=/home/ubuntu/dots-runtime/data/qq-mail.json` in the account service environment. The existing enabled/address/authorizationCode JSON is read directly. The secret is not copied. Disabling that mail file also disables this source of SMTP credentials.

Standalone SMTP configuration:

```
SHIYAN_MAIL_FROM=your-verified-sender@example.com
SHIYAN_SMTP_HOST=smtp.example.com
SHIYAN_SMTP_PORT=465
SHIYAN_SMTP_SECURE=true
SHIYAN_SMTP_USER=your-smtp-account
SHIYAN_SMTP_PASSWORD=your-app-password
```

Port 587 requires `SHIYAN_SMTP_SECURE=false` and always upgrades with STARTTLS. TLS certificate verification is required in both modes. SMTP uses the Python standard library; no new package is needed.

Alternatively, set `SHIYAN_MAIL_FROM` and `SHIYAN_RESEND_API_KEY` for Resend with a verified sender. Resend takes precedence when both providers are configured.

After configuring the environment, restart only `shiyan-accounts.service`. `GET /v1/auth/status` reports `emailDeliveryAvailable`. Without a sender, requesting a code returns HTTP 503; account creation cannot bypass verification. `POST /v1/auth/register-code` accepts `{email}`, and registration/bootstrap additionally accepts `verificationCode` alongside existing account fields.
