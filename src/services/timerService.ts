export class PracticeTimer {

    private interval: NodeJS.Timeout | null = null;
    private seconds: number = 0;
    private isRunning: boolean = false;
    private onTick: (formatted: string) => void;

    constructor(onTick: (formatted: string) => void) {
        this.onTick = onTick;
    }

    private formatTime(): string {
        const mins = Math.floor(this.seconds / 60);
        const secs = this.seconds % 60;

        const mm = mins < 10 ? `0${mins}` : `${mins}`;
        const ss = secs < 10 ? `0${secs}` : `${secs}`;

        return `${mm}:${ss}`;
    }

    start() {
        if (this.isRunning) return;

        this.isRunning = true;

        this.interval = setInterval(() => {
            this.seconds++;
            this.onTick(this.formatTime());
        }, 1000);
    }

    pause() {
        if (!this.isRunning || !this.interval) return;

        clearInterval(this.interval);
        this.interval = null;
        this.isRunning = false;
    }

    resume() {
        if (this.isRunning) return;
        this.start();
    }

    reset() {
        if (this.interval) {
            clearInterval(this.interval);
        }

        this.interval = null;
        this.seconds = 0;
        this.isRunning = false;

        this.onTick("00:00");
    }

    stop(): string {
        if (this.interval) {
            clearInterval(this.interval);
        }

        const finalTime = this.formatTime();

        this.interval = null;
        this.seconds = 0;
        this.isRunning = false;

        this.onTick("00:00");

        return finalTime;
    }

    isActive(): boolean {
        return this.isRunning;
    }
}
