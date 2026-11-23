# Settings, Integrations, Email (1.67.54)

Settings has an Integrations row ("Email, GitHub, WhatsApp and other accounts bots can use"). Integrations lists Email ("Gmail and Outlook, read through Thunderbird on the laptop"). The Email page reads the laptop's Thunderbird through the Commonpost bridge. The throwaway server's HOME has no bridge, so the page must settle on its repair state.

## Sub-features

- `repair` Thunderbird on the laptop "Needs attention", "The Commonpost mail bridge is not installed on the laptop." and "Ask a bot to repair email." within 25 s; never a Found or Connected row, Use these accounts or Not reachable, and it holds for 6 s.
- `plain-reason` from 1.67.55 the add-on's notice or raw error never reaches the screen (`unsupportedLine`, unit tests in `emailScreenModel.test.ts`; the throwaway server cannot make the add-on fail).
- `back` Back returns to Integrations.

## Driving it with adb and uiautomator

Flow 13 taps the Settings gear on Chats, scrolls to Integrations, opens Email and reads the repair state from text or content-desc (a Row merges its texts into its description).
