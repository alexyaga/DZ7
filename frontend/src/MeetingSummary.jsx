import { useId } from 'react'
import { Sparkles } from 'lucide-react'

function SummaryList({ title, items }) {
  return (
    <div className="summary-block">
      <h3>{title}</h3>
      {items.length ? (
        <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
      ) : <p>Нет данных.</p>}
    </div>
  )
}

export function MeetingSummary({ summary }) {
  const titleId = useId()
  return (
    <section className="panel" aria-labelledby={titleId}>
      <div className="panel-heading">
        <h2 id={titleId}><Sparkles size={19} aria-hidden="true" /> Конспект встречи</h2>
      </div>
      <div className="panel-body summary-grid">
        <div className="summary-block">
          <h3>Краткое содержание</h3>
          <p>{summary.summary || 'Нет данных.'}</p>
        </div>
        <SummaryList title="Принятые решения" items={summary.decisions} />
        <div className="summary-block">
          <h3>Задачи после встречи</h3>
          {summary.tasks.length ? (
            <ul>
              {summary.tasks.map((task, index) => (
                <li key={index}>
                  <strong>{task.description}</strong><br />
                  <span className="task-meta">Исполнитель — {task.assignee ?? 'не указан'}. Срок — {task.deadline ?? 'не указан'}.</span>
                </li>
              ))}
            </ul>
          ) : <p>Нет данных.</p>}
        </div>
        <SummaryList title="Открытые вопросы" items={summary.open_questions} />
      </div>
    </section>
  )
}
