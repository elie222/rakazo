type DemoCardLine = {
  k: string;
  v: string;
};

export type DemoMessage =
  | { type: "time"; text: string }
  | { type: "meta"; text: string }
  | { type: "user"; text: string }
  | { type: "bot"; text: string }
  | { type: "typing" }
  | { type: "card"; lines: DemoCardLine[] };

export type DemoRoutine = {
  name: string;
  when: string;
  instruction?: string;
  active?: boolean;
  runs?: DemoRoutineRun[];
};

export type DemoRoutineRun = {
  mark: string;
  color: string;
  text: string;
  time: string;
};

export type DemoScreen = {
  host: string;
  title: string;
  lines: string[];
};

export type DemoBot = {
  id: string;
  name: string;
  color: string;
  time: string;
  preview: string;
  routines: DemoRoutine[];
  screen: DemoScreen;
  thread: DemoMessage[];
  reply: string;
};

export type RosterBot = {
  name: string;
  color: string;
  slug: string;
  desc: string;
};

export const DEMO_BOTS: DemoBot[] = [
  {
    id: "chief",
    name: "Chief of Staff",
    color: "#3EC5A8",
    time: "Yesterday",
    preview: "venue booked, contract sent for signature",
    routines: [{ name: "Monday briefing", when: "Mondays 7am" }],
    screen: {
      host: "notion.so",
      title: "Offsite — week of the 14th",
      lines: ["Harbor House held", "Contract out for signature", "4 calendar holds → invites"],
    },
    thread: [
      { type: "time", text: "Yesterday 9:02 AM" },
      { type: "user", text: "lock the offsite for the week of the 14th" },
      {
        type: "bot",
        text: "looking at three venues in range. i will hold dates and come back before anything is signed.",
      },
      {
        type: "card",
        lines: [
          { k: "Held", v: "3 venues · 14th–16th" },
          { k: "Budget", v: "$8,400 of $10k" },
          { k: "Waiting", v: "harbor house quote" },
        ],
      },
      { type: "user", text: "harbor house if the quote lands under 9k" },
      {
        type: "bot",
        text: "quote came in at $8,400. venue booked and the contract is out for signature. calendar holds are now invites.",
      },
    ],
    reply: "added. i will confirm headcount with the crew thread and update the doc.",
  },
  {
    id: "sales",
    name: "Sales Outbound",
    color: "#F5A03C",
    time: "3:10 AM",
    preview: "done. 40 accounts researched, 18 drafts queued",
    routines: [
      { name: "Overnight sourcing", when: "Nightly 1am" },
      { name: "Reply sweep", when: "Weekdays 8am" },
    ],
    screen: {
      host: "app.hubspot.com",
      title: "Seed-stage fintech — review list",
      lines: ["40 accounts scored", "22 LinkedIn profiles read", "18 drafts queued"],
    },
    thread: [
      { type: "time", text: "Yesterday 11:40 PM" },
      {
        type: "user",
        text: "work the seed-stage fintech list overnight, my voice, nothing sent without me",
      },
      {
        type: "bot",
        text: "understood. i will research, score, and draft. everything lands in a review list at 6am.",
      },
      { type: "meta", text: "Created routine ◷ Overnight sourcing" },
      { type: "time", text: "3:10 AM" },
      {
        type: "card",
        lines: [
          { k: "Researched", v: "40 accounts · 22 with a live signal" },
          { k: "Drafted", v: "18 emails + 9 LinkedIn notes" },
          { k: "Skipped", v: "4 · already in pipeline" },
        ],
      },
      {
        type: "bot",
        text: "two of them raised last week, so those drafts lead with the round. everything else follows your usual opener.",
      },
    ],
    reply: "on it — i will queue those and leave the rest in review.",
  },
  {
    id: "inbox",
    name: "Inbox Manager",
    color: "#6A6BF5",
    time: "12:11 AM",
    preview: "sent. inbox at zero, 5 drafts parked",
    routines: [
      { name: "Morning sweep", when: "Weekdays 6am" },
      { name: "Reply Zero", when: "Hourly" },
    ],
    screen: {
      host: "mail.google.com",
      title: "Inbox — 5 drafts parked",
      lines: ["41 threads read", "26 archived · 9 replied", "Nora’s renewal held"],
    },
    thread: [
      { type: "time", text: "Yesterday 11:11 PM" },
      { type: "user", text: "inbox got away from me over the weekend, sweep it?" },
      {
        type: "bot",
        text: "on it. 41 unread since friday. archiving the noise, drafting the rest.",
      },
      { type: "time", text: "12:11 AM" },
      {
        type: "card",
        lines: [
          { k: "Archived", v: "26 newsletters + receipts" },
          { k: "Replied", v: "9 routine threads · scheduling and intros" },
          { k: "Drafted", v: "6 that sound like you · held for your read" },
          { k: "Flagged", v: "1 from nora · contract question" },
        ],
      },
      {
        type: "bot",
        text: "nora is asking whether the renewal covers the new seats. her draft answers yes and quotes the contract line. it is at the top of the held pile.",
      },
      { type: "user", text: "send nora's, i'll take the rest tomorrow" },
      { type: "bot", text: "sent. inbox is at zero, with 5 drafts parked for tomorrow." },
    ],
    reply: "got it. i will handle that on the next sweep and flag anything i am unsure about.",
  },
  {
    id: "account",
    name: "Account Manager",
    color: "#9B5CF6",
    time: "Yesterday",
    preview: "invite's out to sam, helix note added",
    routines: [{ name: "Renewal watch", when: "Daily 9am" }],
    screen: {
      host: "app.hubspot.com",
      title: "Helix — renewal",
      lines: ["Thursday 10am with Sam", "Annual only", "Nora approves"],
    },
    thread: [
      { type: "time", text: "Yesterday 2:40 PM" },
      {
        type: "bot",
        text: "northstar replied on pricing, same thread as last quarter. i already had the context, so i answered without waiting on you.",
      },
      { type: "meta", text: "Updated memory · Account Manager" },
      {
        type: "bot",
        text: "noted for next time: they only sign annual, and nora is the one who approves.",
      },
      { type: "user", text: "good. set the helix renewal call with sam" },
      {
        type: "bot",
        text: "invite's out to sam for thursday 10am, with the renewal summary attached.",
      },
    ],
    reply: "noted. i will remember that for this account.",
  },
  {
    id: "talent",
    name: "Talent Scout",
    color: "#3B82F6",
    time: "Yesterday",
    preview: "3 intros drafted in your voice, held",
    routines: [{ name: "Pipeline refresh", when: "Tue + Thu" }],
    screen: {
      host: "app.ashbyhq.com",
      title: "Infra applicants",
      lines: ["61 read", "9 shortlisted — ran their own cluster", "3 intros held"],
    },
    thread: [
      { type: "time", text: "Yesterday 4:15 PM" },
      {
        type: "user",
        text: "read the infra applicants and shortlist anyone who has run their own cluster",
      },
      {
        type: "card",
        lines: [
          { k: "Read", v: "61 applicants" },
          { k: "Shortlist", v: "9 · real cluster experience" },
          { k: "Drafted", v: "3 intros in your voice" },
        ],
      },
      {
        type: "bot",
        text: "the three i drafted have all shipped a scheduler of their own. held for your read before anything goes out.",
      },
    ],
    reply: "i will pull those and leave the intros in review.",
  },
  {
    id: "expense",
    name: "Expense Manager",
    color: "#F2622A",
    time: "Yesterday",
    preview: "report filed. 9 receipts, nothing outstanding",
    routines: [{ name: "Month-end close", when: "Last Friday" }],
    screen: {
      host: "app.ramp.com",
      title: "Month-end close",
      lines: ["9 receipts matched", "Harbor hotel — two nights", "Report filed · $2,340"],
    },
    thread: [
      { type: "time", text: "Yesterday 3:11 AM" },
      { type: "user", text: "month-end is friday, close out the card for me?" },
      {
        type: "bot",
        text: "i'll match every charge to a receipt and file the report. anything that doesn't line up, i ask instead of guessing.",
      },
      { type: "meta", text: "Created routine ◷ Month-end close" },
      { type: "time", text: "Yesterday 10:11 PM" },
      {
        type: "card",
        lines: [
          { k: "Receipts", v: "9 matched to card charges" },
          { k: "Report", v: "drafted · $2,340 across 3 trips" },
          { k: "Flagged", v: "1 charge · harbor hotel, $412 twice" },
        ],
      },
      {
        type: "bot",
        text: "the harbor hotel charged $412 on the 12th and again on the 14th. double-billed, or two separate nights?",
      },
      { type: "user", text: "two nights, riley stayed the second one" },
      {
        type: "bot",
        text: "that clears it. report filed: 9 receipts matched, $2,340 across 3 trips, nothing outstanding.",
      },
    ],
    reply: "logged. i will fold that into the next close.",
  },
  {
    id: "bugs",
    name: "Bug Triage",
    color: "#D9508A",
    time: "Monday",
    preview: "reproduced 4 of 6, steps in the issues",
    routines: [{ name: "Triage sweep", when: "Every 2h" }],
    screen: {
      host: "sentry.io",
      title: "Auth loop — P1",
      lines: ["6 new reports", "4 reproduced", "Stale session token"],
    },
    thread: [
      { type: "time", text: "Monday 8:30 AM" },
      { type: "user", text: "triage what came in over the weekend" },
      {
        type: "card",
        lines: [
          { k: "Reproduced", v: "4 of 6 reports" },
          { k: "Duplicates", v: "2 · merged into existing" },
          { k: "Severity", v: "1 raised to P1 · auth loop" },
        ],
      },
      {
        type: "bot",
        text: "the auth loop only happens on a stale session token. steps and a video are on the issue.",
      },
    ],
    reply: "i will reproduce it and attach the steps to the issue.",
  },
];

export const DEMO_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Researches accounts overnight, scores intent, drafts in your voice, leaves a review list.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Archives the noise, replies to routine threads, parks drafts that need your read.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Reads every applicant, shortlists against your bar, writes the intro emails.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Matches receipts to charges, files the report, asks before guessing.",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "rakazo/bug-triage",
    desc: "Reproduces reports in a real browser and attaches steps to the issue.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Keeps renewal context, answers known questions, escalates the rest.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Watches spend daily, pauses what is not converting, reports what changed.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Runs the week: briefings, bookings, and handoffs between your other bots.",
  },
];
