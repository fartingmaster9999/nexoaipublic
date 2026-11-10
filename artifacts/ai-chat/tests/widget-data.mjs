export const quiz = {
  version: 1, id: 'biology', type: 'quiz', title: 'Biology practice', description: 'Two questions to check your understanding.',
  fallback: 'Mitochondria generate most cellular ATP; DNA stores genetic information.',
  questions: [
    { id: 'q1', prompt: 'Which organelle produces most ATP?', options: [{ id: 'a', text: 'Mitochondrion' }, { id: 'b', text: 'Nucleus' }], answerId: 'a', explanation: 'Mitochondria generate most ATP through cellular respiration.' },
    { id: 'q2', prompt: 'Which molecule stores genetic information?', options: [{ id: 'a', text: 'DNA' }, { id: 'b', text: 'Glucose' }], answerId: 'a', explanation: 'DNA encodes hereditary information in its sequence of bases.' },
  ],
};
export const chart = {
  version: 1, id: 'growth', type: 'chart', title: 'Illustrative example: plant growth', fallback: 'Illustrative only: plant A grows from 2 to 5 cm; plant B grows from 1 to 4 cm.',
  chartType: 'line', x: { label: 'Day', type: 'number', unit: 'days' }, y: { label: 'Height', unit: 'cm' },
  provenance: { kind: 'illustrative', detail: 'Illustrative example, not measured data.' },
  series: [
    { id: 'plant_a', name: 'Plant A', points: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 5 }] },
    { id: 'plant_b', name: 'Plant B', points: [{ x: 1, y: 1 }, { x: 2, y: null }, { x: 3, y: 4 }] },
  ],
};
export const math = {
  ...chart, id: 'math', title: 'Sine and quadratic functions', chartType: 'line',
  x: { label: 'x', type: 'number' }, y: { label: 'y', unit: 'dimensionless' },
  provenance: { kind: 'calculated', detail: 'Calculated locally from sin(x) and x squared.' },
  series: [
    { id: 'sine', name: 'sin(x)', formula: { fn: 'sin', min: -3, max: 3, samples: 61 } },
    { id: 'square', name: 'x²', formula: { fn: 'quadratic', min: -3, max: 3, samples: 61 } },
  ],
};
export const expression = {
  ...math, version: 2, id: 'expression', title: 'Sinc expression plot',
  provenance: { kind: 'calculated', detail: 'Version 2 expression evaluated locally.' },
  series: [{ id: 'sinc', name: 'sin(x)/x', formula: { expression: 'sin(x)/x', min: -2, max: 2, samples: 5 } }],
};
export const bar = { ...chart, id: 'bar', chartType: 'bar', x: { label: 'Group', type: 'category' },
  series: [{ id: 'count', name: 'Count', points: [{ x: 'A', y: 5 }, { x: 'B', y: 8 }] }] };
export const scatter = { ...chart, id: 'scatter', chartType: 'scatter' };
export const donut = { ...bar, id: 'donut', chartType: 'donut', y: { label: 'Share', unit: '%' },
  series: [{ id: 'share', name: 'Share', points: [{ x: 'A', y: 60 }, { x: 'B', y: 40 }] }] };
export const fence = (widget) => '```nexo-widget\n' + JSON.stringify(widget) + '\n```';
