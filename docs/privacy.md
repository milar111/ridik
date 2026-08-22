---
layout: default
title: Privacy Policy
description: Ridik — Privacy Policy
---

# Ridik — Privacy Policy

**Last updated: 17 August 2026**

Ridik is a voice organiser for iPhone and Android. This policy describes exactly
what happens to your information. It is written to be checkable against the app:
every claim below corresponds to code in a public repository at
<https://github.com/milar111/ridik>.

There is no account, no sign-up, no password and no advertising.

---

## The short version

- **Everything you create stays on your phone**, in one file.
- **To understand a sentence, the words you said go to Google.** So do a short
  list of your own labels — the names of your lists, projects and the people you
  track — and today's date. Nothing else.
- **What is *inside* a note never leaves.** Neither does what anything cost, a
  phone number, an address, or anywhere you have been.
- **You are asked before anything is sent**, on the first screen, and the app
  works if you say no.
- **No analytics, no tracking, no profiling, no advertising identifiers.**

---

## What stays on your device

Your calendar events, reminders, tasks, notes, lists, checklists, spending
records, habits, timetable, saved places, and the people you keep track of are
stored in a single database file on your device. They are not uploaded to us. We
do not operate a server that holds your content, and we could not retrieve it if
asked.

That file is included in your phone's own backup. If you have iCloud Backup or
Google Backup switched on, a copy exists in **your** account under **your**
control, governed by Apple's or Google's terms rather than ours. You can also
export everything yourself as a single readable file at any time.

---

## What leaves your device, and when

### 1. Understanding what you said — Google (Gemini API)

Turning "remind me to call Ivo at four" into a reminder requires a language
model, which does not run on a phone. When you speak or type a request, the
following is sent to Google's Gemini API:

- the words of that request
- today's date and your time zone offset
- a short index of **your own labels** so the assistant can tell your things
  apart: the names of your lists, projects, notes, habits, places, spending
  categories and the people you track, plus the titles and times of what is on
  your calendar today and tomorrow and what is on your timetable, and your open
  tasks with their due dates

The following is **never** included: the contents of a note, any amount of money,
any currency, any phone number, any email address, any postal address, any
coordinates, or any history of where you have been.

This happens only after you have agreed on the first-run screen, which names
Google explicitly. If you decline, no request is ever sent — the app falls back
to matching simple phrases entirely on your device, and tells you it has done so.

### 2. Turning speech into text — your phone, or Apple/Google

Your phone converts speech to text itself whenever it has an offline voice for
your language. When it does not — which is common on Android — the recording is
processed by the same speech service your keyboard's microphone uses (Apple or
Google), under their terms. If you have declined the first-run permission, Ridik
will **not** do this: it asks you to type instead.

**Ridik keeps no audio.** The recording is discarded as soon as it becomes text.

### 3. Optional: better transcription — OpenAI (Whisper)

Off unless you switch it on and paste your own API key. When on, the audio of a
recording is uploaded to OpenAI for transcription.

### 4. Optional: the daily briefing notification — OneSignal

Off unless you switch it on. When on, one sentence summarising your day — which
can include event titles and people's names — is handed to OneSignal to deliver
as a push notification.

### 5. Purchases — RevenueCat, Apple, Google

If you buy a subscription, the purchase is handled by Apple's or Google's payment
system. **We never see your card details, name or billing address.** Subscription
status is managed through RevenueCat, which receives an anonymous identifier for
your installation and the fact of a purchase.

### 6. Calendar sync — Google Calendar (optional)

If you connect Google Calendar, events are synchronised between Ridik and your
Google account using access you grant and can revoke at any time from your Google
account settings. The access token is stored in your device's secure keychain and
nowhere else.

---

## Analytics and tracking

**There are none.** Ridik does not collect usage analytics, does not build a
profile of you, does not use advertising identifiers, does not fingerprint your
device, and contains no third-party tracking SDK. Nothing you do in the app is
counted or reported anywhere.

We do not sell, rent or share personal information. There is no third-party
advertising and no data brokerage.

---

## Children

Ridik is not directed at children under 13. It collects no personal information
from anyone, so it holds none belonging to a child.

---

## Your rights

Because your content never reaches us, most data-protection requests are things
you can carry out yourself, immediately and without asking:

| Right | How |
| --- | --- |
| **Access / portability** | Menu → Backup → export everything as one readable file |
| **Erasure** | Menu → Settings → Erase everything, or delete the app |
| **Withdraw consent** | Menu → Settings → *Where your words go* → Stop sending |
| **Object to processing** | Decline on first run, or withdraw as above |

If you are in the EEA or UK, the legal basis for sending a request to Google is
your **consent** (GDPR Art. 6(1)(a)), obtained on the first-run screen before
anything is sent, and withdrawable at any time in Settings. The legal basis for
processing a purchase is **performance of a contract** (Art. 6(1)(b)).

For anything you cannot do yourself, contact us below and we will answer within
30 days.

---

## Retention

We hold nothing to retain. On your device, your content persists until you delete
it. Requests sent to Google are subject to Google's retention terms for the Gemini
API. Purchase records are retained by Apple, Google and RevenueCat as required for
billing and tax.

---

## Security

Access tokens and any API keys you enter are stored in the operating system's
secure keychain (iOS Keychain / Android Keystore), never in the app's ordinary
storage and never in the app's source. All network requests use HTTPS.

---

## Changes

If this policy changes in a way that affects what leaves your device, the app
will ask again rather than relying on a quietly updated page. The date at the top
is authoritative.

---

## Contact

**Daniel Yordanov** — d.b.yordanov101@gmail.com

Data controller for the purposes of the GDPR.
