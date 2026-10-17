import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';
import { BUDGET_ALERT_PERCENTAGES, MONTHLY_BUDGET_USD } from './budget-stack.js';

const { budget } = buildApp(undefined, { budget: true });
if (!budget) throw new Error('The budget stack was not built');
const template = Template.fromStack(budget);

interface Notification {
  Notification: {
    NotificationType: string;
    ComparisonOperator: string;
    Threshold: number;
    ThresholdType: string;
  };
  Subscribers: Array<{ SubscriptionType: string; Address: string }>;
}

const notifications = (): Notification[] => {
  const [budgetResource] = Object.values(template.findResources('AWS::Budgets::Budget'));
  return budgetResource?.Properties.NotificationsWithSubscribers as Notification[];
};

describe('BudgetStack', () => {
  it('is one monthly cost budget of 60 US dollars', () => {
    expect(MONTHLY_BUDGET_USD).toBe(60);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'dsa-judge-monthly',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 60, Unit: 'USD' },
      },
    });
  });

  it('emails at 80% and at 100% of actual spending, and at nothing else', () => {
    expect(BUDGET_ALERT_PERCENTAGES).toEqual([80, 100]);
    expect(
      notifications().map((n) => [n.Notification.Threshold, n.Notification.ThresholdType]),
    ).toEqual([
      [80, 'PERCENTAGE'],
      [100, 'PERCENTAGE'],
    ]);
    for (const { Notification } of notifications()) {
      expect(Notification.NotificationType).toBe('ACTUAL'); // spending so far, not a forecast
      expect(Notification.ComparisonOperator).toBe('GREATER_THAN');
    }
  });

  it('sends every alert, and only by email, to the budgetEmail setting', () => {
    for (const { Subscribers } of notifications()) {
      expect(Subscribers).toEqual([{ SubscriptionType: 'EMAIL', Address: 'alerts@college.edu' }]);
    }
  });

  it('only warns: it creates nothing that could stop a service', () => {
    const types = Object.values(
      template.toJSON().Resources as Record<string, { Type: string }>,
    ).map((r) => r.Type);
    expect(types).toEqual(['AWS::Budgets::Budget']);
  });
});
