import { Link } from "@tanstack/react-router";
import {
  Boxes, Check, GitBranch, Layers, Play, ShieldCheck, Sparkles, Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { GithubMark, Logo } from "../Logo.tsx";

const REPO = "https://github.com/SaeedKhan36/Kapi";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#start", label: "Get started" },
] as const;

// --------------------------------------------------------------------- chrome

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/15 bg-[#f7f4ec]/80 backdrop-blur-xl">
      <div className="shell flex h-16 items-center gap-8">
        <Link to="/" aria-label="kapi home"><Logo /></Link>

        <nav className="hidden gap-6 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-muted transition-colors hover:text-bright"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            aria-label="kapi on GitHub"
            className="hidden size-10 place-items-center rounded-full border-[1.5px] border-line bg-white text-bright shadow-[2px_2px_0_#1c1917] transition-[transform,box-shadow,background-color] hover:-translate-y-px hover:bg-[#fef08a] hover:shadow-[3px_3px_0_#1c1917] sm:grid"
          >
            <GithubMark className="size-[18px]" />
          </a>
          <LandingAuthActions />
        </div>
      </div>
    </header>
  );
}

function LandingAuthActions() {
  return <Link to="/app" className="landing-btn-primary !px-4 !py-2 text-sm">Open dashboard</Link>;
}


export function MarketingFooter() {
  return (
    <footer className="border-t border-line/15 py-10">
      <div className="shell flex flex-col items-center justify-between gap-4 sm:flex-row">
        <Logo />
        <p className="text-xs text-dim">
          Free and open source. Inspired by capy.ai, built to run on free tiers.
        </p>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-xs text-dim transition-colors hover:text-bright"
        >
          <GithubMark className="size-3.5" /> Source
        </a>
      </div>
    </footer>
  );
}

// ----------------------------------------------------------------------- hero

export function Hero() {
  return (
    <section className="shell grid items-center gap-12 py-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:py-20">
      <div>
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-[#dbeafe] px-3 py-1 text-xs font-semibold text-bright">
          <Sparkles className="size-3.5" />
          New: multi-agent runs on your repos
        </span>

        <p className="font-display mt-7 text-5xl font-bold leading-[0.95] tracking-tight sm:text-6xl lg:text-[4.25rem]">
          kapi
        </p>

        <h1 className="font-display mt-3 max-w-xl text-balance text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl">
          Your AI engineering team, working in parallel.
        </h1>

        <p className="mt-5 max-w-md text-[1.05rem] leading-relaxed text-muted">
          One goal in. A master plans the graph. Workers build each piece in
          their own sandbox, on their own branch.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link to="/app" className="landing-btn-primary">
            Start a run
          </Link>
          <a href="#how" className="landing-btn-secondary">
            <Play className="size-3.5 fill-current" />
            See how it works
          </a>
        </div>
      </div>

      <HeroCollage />
    </section>
  );
}

function HeroCollage() {
  return (
    <div className="relative mx-auto h-[22rem] w-full max-w-md sm:h-[26rem] lg:max-w-none">
      <div className="landing-card landing-float-a absolute left-0 top-6 z-10 w-[58%] rotate-[-2deg] bg-[#fef08a] p-4 sm:left-2 sm:top-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-bright/70">Task list</p>
        <ul className="mt-3 space-y-2 text-sm font-medium">
          {["Plan the API contract", "Ship the frontend", "Add database migration", "Open the PR"].map((item, i) => (
            <li key={item} className="flex items-center gap-2">
              <span className={`grid size-4 place-items-center rounded-full border border-line ${i < 2 ? "bg-ok" : "bg-white"}`}>
                {i < 2 && <Check className="size-2.5" strokeWidth={3} />}
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="landing-card landing-float-b absolute right-0 top-0 z-20 w-[48%] rotate-[3deg] bg-[#bae6fd] p-4 sm:right-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-bright/70">Workers</p>
        <div className="mt-3 space-y-2">
          {[
            { role: "frontend", status: "running" },
            { role: "backend", status: "ready" },
            { role: "database", status: "waiting" },
          ].map((row) => (
            <div key={row.role} className="flex items-center justify-between rounded-xl border border-line/40 bg-white/70 px-2.5 py-1.5 text-xs font-medium">
              <span>{row.role}</span>
              <span className="text-dim">{row.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="landing-card landing-float-c absolute bottom-2 left-[18%] z-30 w-[72%] rotate-[1deg] bg-white p-4 sm:bottom-4 sm:left-[22%]">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Run · add /health endpoint</p>
          <span className="rounded-full border border-line bg-[#dcfce7] px-2 py-0.5 text-[10px] font-semibold uppercase">Live</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded-full border border-line bg-[#fef08a] px-2 py-0.5 text-[11px] font-medium">planning</span>
          <span className="rounded-full border border-line bg-[#bae6fd] px-2 py-0.5 text-[11px] font-medium">3 workers</span>
          <span className="rounded-full border border-line bg-[#e9d5ff] px-2 py-0.5 text-[11px] font-medium">daytona</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- how it works

const STEPS = [
  {
    n: "01",
    title: "Plan the graph",
    body: "The master clones your repo read-only and turns the goal into tasks with real dependencies.",
    tone: "bg-white",
    icon: Workflow,
  },
  {
    n: "02",
    title: "Run in parallel",
    body: "Every ready task gets its own sandbox and branch. Workers talk as interfaces land.",
    tone: "bg-[#fef08a]",
    icon: Layers,
  },
  {
    n: "03",
    title: "Ship as a PR",
    body: "Commits land on worker branches, merge into an integration branch, and open a pull request.",
    tone: "bg-[#bae6fd]",
    icon: GitBranch,
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how" className="shell scroll-mt-20 py-16 lg:py-20">
      <div className="reveal mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Not just another coding bot
        </h2>
        <p className="mt-3 text-muted">
          kapi is a small team: a planner, parallel workers, and a review loop — all on free tiers.
        </p>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <article
            key={step.title}
            className={`landing-card reveal ${step.tone} p-5`}
            style={{ transitionDelay: `${i * 70}ms` }}
          >
            <div className="flex items-start justify-between">
              <span className="grid size-9 place-items-center rounded-full border border-line bg-[#dbeafe] text-xs font-bold">
                {step.n}
              </span>
              <step.icon className="size-5 text-bright/70" />
            </div>
            <h3 className="font-display mt-5 text-xl font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// --------------------------------------------------------------- capabilities

const FEATURES = [
  {
    icon: Boxes,
    title: "Real isolation",
    body: "Each worker gets a fresh Daytona sandbox and its own git branch — never shared state.",
  },
  {
    icon: ShieldCheck,
    title: "Scoped credentials",
    body: "Sandboxes receive a one-hour token for one repository. Your own login never enters the sandbox.",
  },
  {
    icon: Workflow,
    title: "A dependency graph",
    body: "Tasks declare what they need. The scheduler starts every ready wave at once, not a queue.",
  },
] as const;

export function Capabilities() {
  return (
    <section id="capabilities" className="shell scroll-mt-20 py-8 lg:py-12">
      <div className="grid items-center gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-12">
        <div className="reveal">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-[2.35rem]">
            Designed for the way an engineering team actually works
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            Sign in with GitHub, pick a repo you own, install the kapi app once,
            and watch the plan come back while workers build in parallel.
          </p>
          <ul className="mt-6 space-y-3">
            {["Infinite parallel waves", "Git-native branches and PRs", "Works on free Gemini + Neon + Daytona"].map((item) => (
              <li key={item} className="flex items-center gap-3 text-sm font-medium">
                <span className="grid size-6 place-items-center rounded-full border border-line bg-[#bae6fd]">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal landing-card bg-[#fff8e7] p-5 sm:p-6">
          <span className="inline-flex rounded-full border border-line bg-[#dcfce7] px-2.5 py-1 text-[11px] font-semibold">
            Popular with solo builders
          </span>
          <h3 className="font-display mt-4 text-2xl font-bold tracking-tight">
            From messy goal to polished PR
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Brainstorm Monday, let workers ship branches Tuesday, walk into review with a clean pull request.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {[
              { title: "Plan", tone: "bg-[#fef08a]" },
              { title: "Frontend", tone: "bg-[#bae6fd]" },
              { title: "Backend", tone: "bg-white" },
              { title: "Integration PR", tone: "bg-[#dcfce7]" },
            ].map((card) => (
              <div key={card.title} className={`rounded-2xl border border-line ${card.tone} p-3`}>
                <p className="text-sm font-semibold">{card.title}</p>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1.5 w-full rounded-full bg-black/10" />
                  <div className="h-1.5 w-4/5 rounded-full bg-black/10" />
                  <div className="h-1.5 w-2/3 rounded-full bg-black/10" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <article
            key={feature.title}
            className="landing-card reveal bg-white p-5"
            style={{ transitionDelay: `${i * 60}ms` }}
          >
            <feature.icon className="size-5" />
            <h3 className="font-display mt-4 text-lg font-semibold">{feature.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{feature.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------ cta

export function CallToAction() {
  return (
    <section id="start" className="shell scroll-mt-20 py-16 lg:py-20">
      <div className="reveal relative overflow-hidden rounded-[2rem] border border-line bg-[#c7d2fe] px-6 py-14 text-center shadow-[6px_6px_0_#1c1917] sm:px-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-white/30 blur-2xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-16 -left-8 size-48 rounded-full bg-[#fef08a]/50 blur-2xl"
        />
        <div className="relative">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to give the team a goal?
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-muted">
            Sign in, connect GitHub, install the kapi app on a repo, and start a run.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" className="landing-btn-primary">
              Open the dashboard
            </Link>
            <a href={REPO} target="_blank" rel="noreferrer" className="landing-btn-secondary">
              <GithubMark className="size-4" />
              View source
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Kept for routes that still import older section names during transition. */
export function StatStrip() { return null; }
export function ArchitectureSection() { return null; }
export function Pricing() { return null; }
export function Faq() { return null; }

export function Band({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
