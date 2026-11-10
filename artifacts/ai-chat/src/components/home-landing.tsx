import { useState } from 'react';
import type { Ref } from 'react';
import { ArrowRight, BookOpen, Code2, ListChecks, PenLine, Shuffle, CornerDownLeft } from 'lucide-react';
import './home-welcome.css';

type Prompt = { label: string; text: string };

type Props = {
  logoUrl: string;
  prompts: Prompt[];
  onStart: () => void;
  onPrompt: (text: string) => void;
  onDraftPrompt?: (text: string) => void;
  onOpenHistory?: (trigger: HTMLButtonElement) => void;
  historyOpen?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
};

type Idea = { title: string; text: string };
type Category = { id: string; label: string; blurb: string; Icon: typeof ListChecks; ideas: Idea[] };

const categories: Category[] = [
  {
    id: 'plan', label: 'Plan', blurb: 'Turn a messy pile into an order you can follow.', Icon: ListChecks,
    ideas: [
      { title: 'Sort out a busy week', text: 'Help me sort out my week. I will list my tasks and deadlines; ask me what matters most, then give me a day-by-day order I can actually follow.' },
      { title: 'Break down a big project', text: 'I have a big project and do not know where to start. Ask me two questions about it, then break it into small steps with the first one I can do in 20 minutes.' },
      { title: 'Prep for an exam', text: 'Make me a study plan for an exam. Ask for the date, topics, and how many hours a day I have, then build a realistic schedule with review days.' },
      { title: 'Pick between options', text: 'I am deciding between a few options. Help me compare them with a simple table of pros, cons, and what would change my mind.' },
    ],
  },
  {
    id: 'learn', label: 'Learn', blurb: 'Plain explanations with one good example.', Icon: BookOpen,
    ideas: [
      { title: 'Explain a concept simply', text: 'Explain a concept to me like I am new to it, with one concrete example and one common mistake people make. The concept is: ' },
      { title: 'Quiz me', text: 'Quiz me on a topic, one question at a time. Wait for my answer, tell me what I got right, and adjust the difficulty. The topic is: ' },
      { title: 'Walk through a math problem', text: 'Walk me through solving this problem step by step, checking my understanding before moving on: ' },
      { title: 'Compare two ideas', text: 'Compare these two ideas side by side, show where they overlap, and give me a quick way to remember the difference: ' },
    ],
  },
  {
    id: 'write', label: 'Write', blurb: 'From a rough thought to a clear draft.', Icon: PenLine,
    ideas: [
      { title: 'Outline an essay', text: 'Help me outline an essay. Ask me for the prompt and my rough opinion, then suggest a thesis and a 5-part structure.' },
      { title: 'Tighten my writing', text: 'Edit the text I paste next to be clearer and shorter while keeping my voice. Show what you changed and why.' },
      { title: 'Draft a tricky message', text: 'Help me write a polite but direct message. I will describe the situation and who it is for.' },
      { title: 'Turn notes into a summary', text: 'Turn the notes I paste next into a clean summary with key points, open questions, and next steps.' },
    ],
  },
  {
    id: 'build', label: 'Build', blurb: 'Working code you can run in the workspace.', Icon: Code2,
    ideas: [
      { title: 'A small task list app', text: 'Build a small, responsive task list app in HTML, CSS and JavaScript with working add, complete, and delete controls. Make it run locally in the Nexo workspace without external services.' },
      { title: 'A flashcard trainer', text: 'Build a flashcard study app in HTML, CSS and JavaScript where I can add cards, flip them, and mark them known. Run it in the Nexo workspace. Keep it functional with in-memory state; if you add localStorage, guard access and fall back when unavailable in the sandbox.' },
      { title: 'A budget tracker', text: 'Build a simple budget tracker in HTML, CSS and JavaScript with income, expenses, categories, and a running total. Keep it local with no external services.' },
      { title: 'A Python data script', text: 'Write a Python script that reads a small CSV of my study hours, prints weekly totals, and plots them. Include sample data so it runs in the Nexo workspace.' },
    ],
  },
];

export function HomeLanding({ logoUrl, onStart, onPrompt, onDraftPrompt, onOpenHistory, historyOpen = false, headingRef }: Props) {
  const [catIndex, setCatIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const cat = categories[catIndex];
  const visible = [0, 1].map((k) => cat.ideas[(offset + k) % cat.ideas.length]);
  const draft = onDraftPrompt ?? onPrompt;

  const use = (idea: Idea) => {
    setPicked(idea.title);
    draft(idea.text);
  };

  return (
    <div className="home-landing nx-welcome" data-testid="home-landing">
      <div className="nx-center">
        <button className="nx-mark nx-in" style={{ ['--d' as string]: '0ms' }}
          type="button" onClick={(event) => onOpenHistory?.(event.currentTarget)}
          aria-label={historyOpen ? 'Close conversation history' : 'Open conversation history'}
          aria-expanded={historyOpen} aria-controls="history-sidebar" data-testid="button-home-logo">
          <img src={logoUrl} alt="" aria-hidden="true" />
        </button>
        <h1 ref={headingRef} tabIndex={-1} className="nx-title nx-in" style={{ ['--d' as string]: '110ms' }}>
          What's on your mind<span className="nx-accent"> today?</span>
        </h1>
        <p className="nx-intro nx-in" style={{ ['--d' as string]: '170ms' }}>
          Start with a question or a rough idea. Think it through, learn it, write it up, or build it into something you can run.
        </p>
        <div className="nx-actions nx-in" style={{ ['--d' as string]: '220ms' }}>
          <button className="nx-primary" type="button" onClick={onStart} data-testid="button-start-from-home">
            Start a conversation
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <section className="nx-starts nx-in" style={{ ['--d' as string]: '290ms' }} aria-labelledby="nx-starts-label">
        <div className="nx-starts-head">
          <h2 id="nx-starts-label" className="nx-starts-label">Need a starting point?</h2>
          <div className="nx-tabs" role="group" aria-label="Idea category">
            {categories.map((c, i) => (
              <button key={c.id} type="button" aria-pressed={i === catIndex}
                className={`nx-tab${i === catIndex ? ' is-on' : ''}`}
                onClick={() => { setCatIndex(i); setOffset(0); setPicked(null); }}
                data-testid={`tab-ideas-${c.id}`}>
                <c.Icon size={14} aria-hidden="true" />
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="nx-panel">
          <div className="nx-panel-top">
            <p className="nx-blurb" key={`b-${cat.id}`} aria-live="polite">{cat.blurb}</p>
            <button type="button" className="nx-shuffle" onClick={() => { setOffset((o) => (o + 2) % cat.ideas.length); setPicked(null); }}
              data-testid="button-shuffle-ideas" aria-label="Show other ideas">
              <Shuffle size={14} aria-hidden="true" />
              <span>Other ideas</span>
            </button>
          </div>
          <div className="nx-start-list" key={`${cat.id}-${offset}`}>
            {visible.map((idea, i) => (
              <button
                className={`nx-start${picked === idea.title ? ' is-picked' : ''}`}
                style={{ ['--i' as string]: i }}
                type="button"
                key={idea.title}
                onClick={() => use(idea)}
                data-testid={`home-idea-${cat.id}-${(offset + i) % cat.ideas.length}`}
              >
                <span className="nx-start-icon"><cat.Icon size={16} aria-hidden="true" /></span>
                <span className="nx-start-copy">
                  <b>{idea.title}</b>
                  <small>{idea.text}</small>
                </span>
                <span className="nx-start-use" aria-hidden="true">
                  {picked === idea.title ? 'Added' : 'Use'}
                  <CornerDownLeft size={13} />
                </span>
              </button>
            ))}
          </div>
          <p className="nx-hint">Ideas go into the message box below so you can edit them before sending.</p>
        </div>
      </section>
    </div>
  );
}
