---
layout: default
title: Privacy Policy
description: Ridik — Privacy Policy
---

# Ridik — Privacy Policy

**Last updated: 1 September 2026**

Ridik is a voice organiser for iPhone and Android. This policy describes exactly
what happens to your information. It is written to be checkable against the app:
every claim below corresponds to code in a public repository at
<https://github.com/milar111/ridik>.

There is no account, no sign-up, no password and no advertising.

---

## The short version

- **Everything you create stays on your phone**, in one file.
- **To understand a sentence, the words you said go to Google**, by way of our
  own server, which counts what your subscription allows and keeps nothing. So
  does a short list of your own labels — the names of your lists, projects and
  the people you track — and today's date. Nothing else.
- **What is *inside* a note never leaves.** Neither does what anything cost, a
  phone number, an address, or anywhere you have been.
- **You are asked before anything is sent**, on the first screen, and the app
  works if you say no.
- **Ridik counts how it is used, on your phone.** A short fixed list of things
  like "a request was made, it took one to two seconds, it worked" — never what
  you said and never what it filed. You can read every row of it, export it and
  clear it, at Menu → Usage.
- **Those counts are sent nowhere unless you switch that on**, and the switch is
  off. It is one switch, and it also turns on crash reports.
- **No advertising identifiers, no profiling, no third-party tracking SDK**, and
  nothing you create is ever counted.

---

## What stays on your device

Your calendar events, reminders, tasks, notes, lists, checklists, spending
records, habits, timetable, saved places, and the people you keep track of are
stored in a single database file on your device. They are not uploaded to us. We
run one server and it does not hold your content — it passes assistant requests
through to Google and keeps no copy of your database — so we could not retrieve
your notes, tasks or calendar if asked.

The usage counts described further down are in that same file, and they stay
there unless you switch the upload on.

That file is included in your phone's own backup. If you have iCloud Backup or
Google Backup switched on, a copy exists in **your** account under **your**
control, governed by Apple's or Google's terms rather than ours. You can also
export everything yourself as a single readable file at any time.

---

## What leaves your device, and when

### 1. Understanding what you said — Google (Gemini API), by way of Ridik's server

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

In the version you install from the App Store or Play, the request goes to
**Ridik's own server**, which forwards it to Google and returns the answer; the
server is how a subscription's allowance is counted, so the request carries the
same anonymous installation identifier RevenueCat issues (§5) and nothing else
about you. It keeps no copy of your database. If instead you paste your own
Google API key on the developer screen, the request goes straight to Google and
touches nothing of ours. The first-run screen states which of the two your copy
is doing.

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

### 4. Optional: better transcription — AssemblyAI

Off unless you paste your own AssemblyAI API key and choose it as the
transcription engine. When on, the audio of a recording is uploaded to
AssemblyAI for transcription, the same way as §3.

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

### 7. Turning a pin into an address — your phone's geocoder (Apple or Google)

When you save a place, the coordinates you picked are handed to your phone's own
geocoding service to be turned into a street address, and an address you type is
handed to it to be turned into coordinates. That is the same service the built-in
Maps app uses, under Apple's or Google's terms. It happens only while you are
editing a place.

Arriving somewhere is checked **on the device**. No history of where you have
been is sent to anyone, by us or through us.

### 8. Optional: usage counts — Ridik's own server

Off unless you switch on **Settings → Help improve Ridik → Send usage and crash
reports**. When on, Ridik posts the counts described under *Counting how the app
is used* below to the same server that carries assistant requests. They go
nowhere else: there is no analytics company involved and no third-party analytics
SDK in the app.

What is sent is exactly what the Usage screen shows you, less the row's own id
and less its timestamp. Nothing finer than the local date a thing happened on is
ever recorded, so there is no time of day in a row to send. A batch carries no
account, no device identifier, no advertising identifier and nothing generated to
stand in for one, so there is nothing in it that says which rows are yours or
that two batches came from the same phone. That has a consequence, stated under
*Your rights*.

This switch is its own decision, separate from the assistant's. It works whether
you allowed the assistant or declined it, because a count with nobody in it is a
different question from sending your words to Google. What it does require is
that you have seen the first-run screen and answered it, so that nothing is ever
sent by somebody who has not been told what leaves.

### 9. Optional: crash reports — Sentry

The same switch. When on, a crash is reported to **Sentry**, a third party, so
that it can be fixed: the exception and its stack trace, the app's version, and
the device model and operating system.

Everything Sentry would otherwise add is turned off rather than trusted —
no screenshot, no view hierarchy, no session replay, no performance tracing, no
breadcrumbs, and no user record — and what is left is stripped again before it
goes. `src/services/analytics/crash.ts` is the file, and it is short. **Your
content is not part of a crash report.** With the switch off, nothing is reported
and a crash is only a crash.

---

## Counting how the app is used

Ridik counts how it is used in two layers, with a switch between them.

**On your phone, always.** Ridik writes a row when something happens that the app
needs to know about itself: a request was made in which mode, took which of five
duration bands and ended how; a tool ran and whether it was undone; a screen was
opened; a permission was answered; the trial moved on. Eleven kinds of event in
total. The list is closed — `src/services/analytics/events.ts` in the public
repository is the whole of it, and the app refuses to write anything the file
does not describe.

**Every property is an enum, a band or a small number. There is no free-text
field anywhere in the shape**, which is why this is checkable rather than
promised. Nothing written there can be a transcript, a note, a title, a name of a
task or a person or a place, an amount, a coordinate, an address, the model's
answer, your time zone, or a time of day. Rows are pruned to whichever comes
first, ninety days or five thousand of them.

You can read every row of it at **Menu → Usage**, export it, and clear it.
"Erase everything" erases it too — unlike the request meter, which is our billing
record, this is yours. It is deliberately left out of a backup file: it is a log
about the app, not a possession, and a backup is for the things you would miss.

**Off your phone, only if you say so.** §8 above. One switch in Settings, off
until you turn it on, covering the upload and the crash reports together.

**What none of this does**, on either layer: it does not build a profile of you,
does not use an advertising identifier, does not fingerprint your device, and
does not track you across apps or websites. There is no third-party analytics
company and no advertising SDK in Ridik at all. The one third-party SDK in this
area is Sentry, for crashes only, described in §9, and inert until the switch is
on.

We do not sell, rent or share personal information. There is no third-party
advertising and no data brokerage.

---

## Children

Ridik is not directed at children under 13. What it stores about a person stays
on that person's phone; the only thing it can be asked to send about how the app
is used carries no identifier of any kind, so nothing we ever receive can be tied
to a child, or to anybody else.

---

## Your rights

Because your content never reaches us, most data-protection requests are things
you can carry out yourself, immediately and without asking:

| Right | How |
| --- | --- |
| **Access / portability** | Menu → Backup → export everything as one readable file |
| **See what is counted** | Menu → Usage — every row, in full, with an export button |
| **Erasure** | Menu → Settings → Erase everything, or delete the app. Menu → Usage → Clear removes the counts on their own |
| **Withdraw consent** | Menu → Settings → *Where your words go* → Stop sending, and Menu → Settings → *Help improve Ridik* → Send usage and crash reports |
| **Object to processing** | Decline on first run, or withdraw as above |

**Uploaded usage counts cannot be deleted individually, because they cannot be
found.** If you have had the upload switched on, a batch carries no identifier,
so the rows are not linked to you, to your phone, or to each other, and there is
nothing we could search on. Switching the setting off stops any further row
leaving, immediately and for good, and clearing the Usage screen removes what has
not gone yet. The same property means nobody, us included, can pick you out of
what was sent.

If you are in the EEA or UK, the legal basis for sending a request to Google is
your **consent** (GDPR Art. 6(1)(a)), obtained on the first-run screen before
anything is sent, and withdrawable at any time in Settings. The legal basis for
uploading usage counts and crash reports is also **consent**, given by turning on
one switch that is off by default and withdrawable by turning it off. The legal
basis for processing a purchase is **performance of a contract** (Art. 6(1)(b)).

For anything you cannot do yourself, contact us below and we will answer within
30 days.

---

## Retention

We hold none of your content to retain. On your device, your content persists
until you delete it, and the usage counts are pruned to whichever comes first,
ninety days or five thousand rows.

Requests sent to Google are subject to Google's retention terms for the Gemini
API. Purchase records are retained by Apple, Google and RevenueCat as required for
billing and tax. Crash reports are retained by Sentry under their terms.

Usage counts you have chosen to upload are kept as a running record of how the
app is used. There is no retention period to state per person, because there is
no person in them: with nothing to group the rows by, they are only ever read as
totals.

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
