import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

/** Minimal public Inbox contract used by focused runtime-kit service tests. */
export class TestInbox implements Inbox {
  readonly nextTurn: UserMessage[] = []
  readonly nextStep: UserMessage[] = []

  clear() {
    this.nextStep.length = 0
    this.nextTurn.length = 0
  }

  append(target: InboxTarget, message: UserMessage) {
    (target === 'next-turn' ? this.nextTurn : this.nextStep).push(message)
  }

  prepend(target: InboxTarget, message: UserMessage) {
    (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(message)
  }

  replace(_messageId: MessageId, _newMessage: UserMessage) { return false }
  remove(_messageId: MessageId) { return false }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]) {
    return (target === 'next-turn' ? this.nextTurn : this.nextStep)
      .splice(start, deleteCount, ...inserted)
  }
}
