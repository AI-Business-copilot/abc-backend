/**
 * LotStatusService
 * Calculates lot status based on expiration date
 * - HEALTHY: > 60 days until expiry
 * - WARNING: 8-60 days until expiry (FEFO priority)
 * - UNUSABLE: ≤ 7 days until expiry
 */
export class LotStatusService {
  /**
   * Calculate lot status based on expiration date
   * @param expirationDate The lot expiration date
   * @param today Optional reference date (defaults to now)
   * @returns Status: HEALTHY, WARNING, or UNUSABLE
   */
  calculateStatus(expirationDate: Date, today?: Date): string {
    const referenceDate = today || new Date();
    const daysUntilExpiry = this.getDaysUntilExpiry(expirationDate, referenceDate);

    if (daysUntilExpiry > 60) {
      return 'HEALTHY';
    }
    if (daysUntilExpiry >= 8 && daysUntilExpiry <= 60) {
      return 'WARNING';
    }
    return 'UNUSABLE'; // 1-7 or expired (≤ 0)
  }

  /**
   * Get effective status: the stored status is checked first, then the expiration date is used.
   * 1. QUARANTINED, SCRAPPED and UNUSABLE in the database are final and returned as they are.
   *    UNUSABLE cannot go stale because a lot never gets further from its expiry date.
   * 2. Otherwise (HEALTHY, WARNING, legacy values) the status is calculated from the expiration date
   *    and today's date, because a stored HEALTHY or WARNING gets out of date as days pass.
   * @param dbStatus Status stored in product_lots.status
   * @param expirationDate Lot expiration date
   * @returns Effective status to display
   */
  getEffectiveStatus(
    dbStatus: string,
    expirationDate: Date,
  ): 'HEALTHY' | 'WARNING' | 'UNUSABLE' | 'QUARANTINED' | 'SCRAPPED' {
    if (dbStatus === 'QUARANTINED' || dbStatus === 'SCRAPPED' || dbStatus === 'UNUSABLE') {
      return dbStatus;
    }

    return this.calculateStatus(expirationDate) as
      | 'HEALTHY'
      | 'WARNING'
      | 'UNUSABLE';
  }

  /**
   * Get days until expiry from expiration date
   * @param expirationDate Lot expiration date
   * @param today Reference date (defaults to now)
   * @returns Number of days until expiry (can be negative if expired)
   */
  getDaysUntilExpiry(expirationDate: Date, today?: Date): number {
    const referenceDate = today || new Date();

    // Normalize both dates to start of day for accurate day calculation
    const ref = new Date(referenceDate);
    ref.setHours(0, 0, 0, 0);

    const exp = new Date(expirationDate);
    exp.setHours(0, 0, 0, 0);

    const diffMs = exp.getTime() - ref.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    return diffDays;
  }

  /**
   * Check if a lot is expired
   * @param expirationDate Lot expiration date
   * @param today Reference date (defaults to now)
   * @returns True if lot is expired
   */
  isExpired(expirationDate: Date, today?: Date): boolean {
    return this.getDaysUntilExpiry(expirationDate, today) <= 0;
  }

  /**
   * Check if a lot is near expiry (WARNING status)
   * @param expirationDate Lot expiration date
   * @param today Reference date (defaults to now)
   * @returns True if lot is within WARNING window (8-60 days)
   */
  isNearExpiry(expirationDate: Date, today?: Date): boolean {
    const daysLeft = this.getDaysUntilExpiry(expirationDate, today);
    return daysLeft >= 8 && daysLeft <= 60;
  }

  /**
   * Check if a lot should be marked unusable
   * @param expirationDate Lot expiration date
   * @param today Reference date (defaults to now)
   * @returns True if lot has ≤ 7 days until expiry or is expired
   */
  isUnusable(expirationDate: Date, today?: Date): boolean {
    return this.getDaysUntilExpiry(expirationDate, today) <= 7;
  }

  /**
   * Get status category for UI color coding
   * @param status Effective lot status
   * @returns UI category: 'green', 'yellow', 'red'
   */
  getStatusColor(
    status: 'HEALTHY' | 'WARNING' | 'UNUSABLE' | 'QUARANTINED' | 'SCRAPPED',
  ): 'green' | 'yellow' | 'red' | 'gray' {
    switch (status) {
      case 'HEALTHY':
        return 'green';
      case 'WARNING':
        return 'yellow';
      case 'UNUSABLE':
      case 'SCRAPPED':
        return 'red';
      case 'QUARANTINED':
        return 'gray';
      default:
        return 'gray';
    }
  }
}
