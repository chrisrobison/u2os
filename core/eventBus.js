class EventBus {
  constructor({ persistEvent } = {}) {
    this.handlers = new Map();
    this.persistEvent = persistEvent;
  }

  subscribe(eventName, handler) {
    const current = this.handlers.get(eventName) || [];
    current.push(handler);
    this.handlers.set(eventName, current);

    return () => {
      const remaining = (this.handlers.get(eventName) || []).filter((h) => h !== handler);
      this.handlers.set(eventName, remaining);
    };
  }

  async publish(eventName, payload = {}) {
    if (this.persistEvent) {
      await this.persistEvent(eventName, payload);
    }

    const exact = this.handlers.get(eventName) || [];
    const wildcard = this.handlers.get('*') || [];
    const handlers = [...exact, ...wildcard];

    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler({ eventName, payload, emittedAt: new Date().toISOString() });
        } catch (error) {
          console.error(`[eventBus] handler failed for ${eventName}:`, error.message);
        }
      })
    );
  }
}

module.exports = EventBus;
