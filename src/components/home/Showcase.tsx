'use client';

import * as React from 'react';
import { motion, useInView } from 'framer-motion';
import {
  Gauge,
  Lock,
  MessageCircleHeart,
  MonitorPlay,
  Sparkles,
  Video,
} from 'lucide-react';
import { GlassCard } from '@/components/ui/GlassCard';

const FEATURES = [
  {
    icon: Gauge,
    title: 'Sync that holds',
    body: 'Every client measures its own clock offset against the server, then corrects drift continuously. Pause on one side and the other is already stopped.',
  },
  {
    icon: MessageCircleHeart,
    title: 'Chat that feels alive',
    body: 'Typing indicators, read receipts, reactions, voice notes, images and files — instant, and beside the film instead of on top of it.',
  },
  {
    icon: Video,
    title: 'See and hear each other',
    body: 'Peer-to-peer voice and video with noise suppression, plus screen sharing when you want to show something instead of describe it.',
  },
  {
    icon: MonitorPlay,
    title: 'Play anything',
    body: 'A direct video link, a YouTube video, or the same local file you both already have. Nothing gets uploaded and nothing gets re-encoded.',
  },
  {
    icon: Lock,
    title: 'Private by default',
    body: 'Rooms exist only while somebody is in them. Add a passphrase, turn on the waiting room, lock the door, or hand the host seat to someone else.',
  },
  {
    icon: Sparkles,
    title: 'Built to be looked at',
    body: 'Glass, depth and motion that respond to you — and step out of the way the moment the lights go down.',
  },
];

function FeatureCard({ feature, index }: { feature: (typeof FEATURES)[number]; index: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const Icon = feature.icon;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1], delay: (index % 3) * 0.06 }}
      className="group"
    >
      {/* An informational card, not a control: no `interactive` tilt, no `glow`,
          no per-card coloured atmosphere, no icon scale on hover. It should read
          as typeset content that happens to sit on a surface. */}
      <GlassCard className="h-full p-7 transition-colors duration-[160ms] ease-swift group-hover:border-white/20">
        <div className="relative">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white/[0.07] text-gold-400 shadow-inner-hairline">
            <Icon size={18} strokeWidth={1.9} />
          </div>
          <h3 className="mt-5 font-display text-lg font-semibold tracking-tight text-primary">{feature.title}</h3>
          <p className="mt-2.5 text-[0.875rem] leading-relaxed text-supporting pretty">{feature.body}</p>
        </div>
      </GlassCard>
    </motion.div>
  );
}

export function Showcase() {
  return (
    <section className="relative py-28 sm:py-36">
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="text-eyebrow uppercase text-gold-400"
          >
            Everything in the room
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.06 }}
            className="mt-4 font-display text-display-lg text-primary balance"
          >
            Distance is the only thing we could not fix
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
            className="mx-auto mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-supporting pretty"
          >
            So we fixed everything else. CineVerse is one room, built for two people who want the
            same film at the same second.
          </motion.p>
        </div>

        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <FeatureCard key={feature.title} feature={feature} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { n: '01', title: 'Open a room', body: 'Pick a name, hit create. You get a six-character code and a link.' },
  { n: '02', title: 'Send the link', body: 'They open it, type a name, and they are in the room with you.' },
  { n: '03', title: 'Choose the film', body: 'Pick from Open Cinema, paste a video link, or load the same local file.' },
  { n: '04', title: 'Press play', body: 'From then on, every play, pause and seek belongs to both of you.' },
];

export function HowItWorks() {
  return (
    <section className="relative py-24 sm:py-28">
      <div className="container">
        <div className="grid gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <div className="lg:sticky lg:top-32 lg:self-start">
            <p className="text-eyebrow uppercase text-gold-400">How it works</p>
            <h2 className="mt-4 font-display text-display-lg text-primary balance">
              Four steps, then the lights go down
            </h2>
            <p className="mt-5 max-w-md text-[1.0625rem] leading-relaxed text-supporting pretty">
              There is no sign-up, no install, and nothing to configure. The room disappears when you
              both leave.
            </p>
          </div>

          <ol className="relative space-y-3">
            <span
              aria-hidden
              className="absolute bottom-6 left-[2.15rem] top-6 w-px bg-white/[0.09]"
            />
            {STEPS.map((step, i) => (
              <motion.li
                key={step.n}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 }}
              >
                <GlassCard className="group flex items-start gap-5 p-6 transition-colors duration-[160ms] ease-swift group-hover:border-white/20">
                  <span className="relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.07] font-mono text-xs font-medium text-gold-400 shadow-inner-hairline">
                    {step.n}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold text-white">{step.title}</h3>
                    <p className="mt-1.5 text-[0.875rem] leading-relaxed text-supporting pretty">{step.body}</p>
                  </div>
                </GlassCard>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
