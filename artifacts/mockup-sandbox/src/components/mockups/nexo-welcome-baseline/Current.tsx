import { HomeLanding } from './_HomeLanding';
import './_group.css';

const prompts = [
  { label: 'Make a plan', text: 'Help me make a realistic plan for a calmer, more focused week.' },
  { label: 'Understand something', text: 'Explain compound interest in plain language, with a simple example.' },
  { label: 'Find the words', text: 'Help me write a thoughtful note to someone I have not checked in with.' },
  { label: 'Write some code', text: 'Write a Python script that plots a damped sine wave with Matplotlib.' },
];

export function Current() {
  return (
    <main className="chat-region home-region" style={{ minHeight: '100vh', marginInline: 'auto' }}>
      <div className="messages">
        <HomeLanding logoUrl="/__mockup/nexo-welcome-logo.png" prompts={prompts}
          onStart={() => {}} onPrompt={() => {}} />
      </div>
    </main>
  );
}
