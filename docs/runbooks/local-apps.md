# Run the real applications locally on Windows

This starts the real customer application, company portal, PostgreSQL, Mosquitto, and local hub together. Data is retained under `.secrets/local/`. It does not run the device/hub simulators, create fictitious staff, or automatically approve support requests.

It is a loopback-only local installation for working with the applications, not a public production deployment. The application websites use HTTP on localhost. Public hosting requires HTTPS and the production configuration.

## Prerequisites and first start

On this workstation the launcher uses Node.js 24+, PostgreSQL 18 at `C:\Program Files\PostgreSQL\18\bin`, and Mosquitto at `C:\Program Files\mosquitto`. Its separate PostgreSQL cluster and MQTT listener do not replace the existing Windows services or databases.

In Windows PowerShell:

```powershell
cd "D:\Voltax-Home-Automation"
npm install
npm run build
node .\tools\run-local.mjs --admin-email joylan928@gmail.com
```

Keep the terminal running. After startup the readiness checks verify PostgreSQL, its restricted application role, MQTT, actual hub telemetry arriving in the cloud, HTTP health, and unauthorized-request rejection. The terminal prints the website addresses and a short-lived customer-owner pairing code.

| Component | Address / storage |
|---|---|
| Customer application | `http://localhost:8088` |
| Company/admin portal | `http://localhost:8098` |
| Dedicated PostgreSQL | `127.0.0.1:55432`, database `voltax` |
| Device MQTT broker | `127.0.0.1:18883`, password-protected |
| Cloud MQTT broker | `127.0.0.1:18884`, separate password-protected broker |
| Persistent installation | `D:\Voltax-Home-Automation\.secrets\local\` |
| Hub database | `.secrets/local/hub/hub.db` |
| PostgreSQL data | `.secrets/local/postgres/` |

## Admin login

The first start creates `joylan928@gmail.com` as `PLATFORM_SUPER_ADMIN` through the existing bootstrap service. It does not overwrite an installation belonging to another email or reset an established administrator.

1. Open the one-time setup URL printed in the terminal. A private copy is saved in `.secrets/local/admin-setup-url.txt`.
2. Choose a password of **at least 12 characters** and confirm it. Passwords are hashed by the existing service, never placed in the launcher or git.
3. Setup signs you in immediately. Use `http://localhost:8098/login/` for later sign-ins with your email and password. No authenticator code is required.

Passwords must contain at least 12 characters. The administrator password configured on this workstation is stored only as a scrypt hash in its private PostgreSQL database; it is not a default password for other installations. Setup links expire after 24 hours and are single use; do not share or commit the private installation files.

## Customer and family access

Open `http://localhost:8088` and enter the **owner pairing code** printed by the launcher. Name the browser when prompted. This creates a real household-owner client in the persistent hub database; household access is paired-browser access rather than the company email/password login.

For a family-member view, invite a member from **Access**, then open the customer app in another browser profile/private window and redeem that invitation. Do not reuse the owner code for a member. Each pairing code works once.

## Support and installer accounts

1. Sign in to the company portal as the super admin.
2. Under **Staff**, create the real staff account and choose **Support** or **Installer**.
3. Give that person their one-time setup link through your chosen trusted channel. They set their own password.
4. Assign them to **My Home** from its home-detail page.
5. Use another browser profile for the staff sign-in, so the admin and staff sessions stay separate.

The launcher registers the running local hub under **My Home**. Its online status is based on actual MQTT telemetry, not a simulated hub. Super admins cannot control a household merely because they administer the platform.

## What needs additional configuration

- **Devices:** no ESP32, fake switch, or simulated sensor is added. The customer device list starts empty. Actual on/off control and sensor-triggered rules require a connected, provisioned device. This broker listens on loopback, so LAN device access needs an explicitly configured LAN listener/firewall and device credentials.
- **Support:** no owner approval is fabricated. Signed support actions remain fail-closed without a trustworthy hub clock, the required owner consent, and delivered start notices. Windows Time is not running on this workstation at preparation time; the launcher does not manufacture a synchronization marker. A real SMTP provider also needs configuration before email-gated cloud support can operate.
- **Updates:** this launcher does not install a release-signing public key or run the privileged Pi updater. Those are separate deployment operations; it does not pretend to apply releases.
- **Notifications/archives:** live push-service delivery and external audit storage need their real provider configuration. The launcher does not send email or configure external accounts.

You can use the actual account, role, assignment, pairing, room/access, and operational interfaces locally. Hardware- and provider-dependent actions require their actual integrations.

## Restart and stop

For optional frontend hot reload and the separate physical Pi/ESP32 setup, use [the hardware lab guide](pi-esp32-lab.md). When developing the admin frontend on port 3001, start the launcher with `$env:LOCAL_ADMIN_ORIGIN = 'http://localhost:3001'`; the normal portal URL is otherwise 8098. This keeps the configured browser origin aligned with the existing write protections.

Press **Ctrl+C** in the launcher terminal. It stops its own app instances, broker, and PostgreSQL cluster. It retains the installation database, keys, accounts, and settings.

Next time:

```powershell
cd "D:\Voltax-Home-Automation"
node .\tools\run-local.mjs --admin-email joylan928@gmail.com
```

Do not delete `.secrets/local` to restart. It contains the database and encryption/signing material, not disposable demo data. A port-occupied message means another process is already listening on a required port; stop the earlier launch instead of starting a second one.
