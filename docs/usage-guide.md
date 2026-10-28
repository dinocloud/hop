# Usage guide: WhatsApp package-tracking agent

> DinoCloud Internal - Confidential · Hackathon PoC · synthetic data, except your phone number

A WhatsApp agent that tells customers where their package is. Customers can also sort out the pickup on their own: more time, another pickup point, a new delivery date, or a return. When a package reaches its pickup point, the customer gets a WhatsApp notice without asking for it.

![Architecture](diagrams/architecture.png)

## The number

Write to **+54 9 11 6842-1638** on WhatsApp from your own phone, or open [wa.me/5491168421638](https://wa.me/5491168421638).

- **No setup.** The first time you write, the agent creates a package for your phone, waiting at one of the three pickup points: Palermo, Belgrano or Caballito.
- **Your number is saved.** The test environment keeps your phone number with your packages and your chat's state, plus your name if you tell the agent. Logs show only its last 4 digits. Ask the team if you want it deleted.
- **English by default.** If you write in Spanish, it answers in Spanish for the rest of the chat.
- **One message at a time.** Wait for each reply before you send the next message.

## What to try

Send these in order, in the same chat. Each row is one message.

| # | Send | What should happen |
|---|---|---|
| 1 | `Where is my package?` | Status, pickup point, address, opening hours and pickup deadline, plus a map pin of the pickup point. |
| 2 | `Can I have 3 more days?` | It tells you the new deadline and asks you to confirm. Nothing is saved yet. |
| 3 | `Yes` | The deadline moves. You can add 1 to 7 days. |
| 4 | `Can I pick it up somewhere else?` | It lists the other pickup points, nearest first, with distance, address and opening hours. |
| 5 | `Belgrano, please` | It asks you to confirm the change. If your package is already in Belgrano, pick another point from the list. |
| 6 | `Yes` | The package goes back in transit to the new point, with no deadline until it arrives. |
| 7 | `Can you deliver it on Friday?` | It confirms the date and asks again. Any day from tomorrow to 14 days ahead works. |
| 8 | `Yes` | Delivery is rescheduled and the package stays in transit. |
| 9 | `I want to return it` | It warns you that a return is final and asks you to confirm. |
| 10 | `Yes` | The package goes back to the sender. |

Then try the other side, sending a package:

| # | Send | What should happen |
|---|---|---|
| 11 | `I want to send a package` | It lists the pickup points and asks where you'll drop it off. |
| 12 | `Palermo` | It registers the package as in transit and gives you its tracking number. |
| 13 | `I dropped it off` | The package is ready for pickup and its deadline starts now. |

### Things it should not do

| Send | What should happen |
|---|---|
| A tracking number that isn't yours, like `ABC-1234` or another tester's | It says it can't find that package. It never shows someone else's package. |
| Something unrelated, like `What's the weather?` | One line with what it can do for you. |
| A city with no pickup points, like `Can you send it to Rosario?` | It says there is no pickup point there and lists the three it has, all in Buenos Aires. |
| More days than allowed, like `Can I have 10 more days?` | It says the limit is 7 days and offers 7 instead. |
| `No` when it asks you to confirm | Nothing changes. |
| A photo, audio or sticker | A fixed reply in Spanish: "Por ahora solo puedo leer mensajes de texto…" |

## The proactive notice (presenter only)

When the shipping system reports that a package reached its pickup point, the customer gets this WhatsApp template:

> Hola Ana, tu paquete ya está en Punto HOP Palermo. Tenés 5 días para retirarlo. Si necesitás más tiempo, cambiar de punto o reprogramar, respondé este mensaje.

The template is in Spanish, as Meta approved it. Testers can't trigger it, because the shipping-system call needs an API key. The presenter sends it from a terminal: see [Flow B in the runbook](e2e-y-demo.md#flujo-b--aviso-proactivo-hook--plantilla). If you reply to the notice, the chat with the agent continues as usual.

## Good to know

- **Your packages only.** The agent only sees the packages linked to the phone you write from.
- **Changes need a "yes".** More time, another pickup point, a new date and a return all start with a preview. Nothing is saved until you confirm in your next message. Sending a package and marking it as dropped off don't ask.
- **More than one package.** If you have more than one package waiting or in transit, the agent names the one it means, or asks you, before it changes anything. `Where is my package?` shows the newest one and mentions the others.
- **The first reply can be slow.** After about 15 minutes with no messages, the first reply takes a few extra seconds.
- **Deadlines** end at 23:59, Buenos Aires time.

## If something goes wrong

| What you see | Likely cause | What to do |
|---|---|---|
| "Perdón, tuve un problema para consultar tu paquete…" | The agent was starting up, or two messages arrived too close together. | Wait a few seconds, then send one message. |
| "I can't find your package" | You wrote from another phone, or gave a tracking number that isn't yours. | Ask `Where is my package?` without a tracking number. |
| No reply after about a minute | Something failed along the way. | Tell the team the time you wrote. They can follow your chat in the logs. |

For the team: [E2E runbook and demo script](e2e-y-demo.md) · [follow a conversation in CloudWatch](referencia-tecnica.md#seguir-una-conversación).
