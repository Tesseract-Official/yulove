import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';

/** Monthly spending limit for the whole AWS account, in US dollars. */
export const MONTHLY_BUDGET_USD = 60;

/** Emails are sent when actual spending passes these percentages of the budget. */
export const BUDGET_ALERT_PERCENTAGES = [80, 100] as const;

export interface BudgetStackProps extends StackProps {
  /** Who is emailed. */
  budgetEmail: string;
}

/** A monthly cost budget with email alerts. It only warns; it never stops anything. */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'dsa-judge-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: 'USD' },
      },
      notificationsWithSubscribers: BUDGET_ALERT_PERCENTAGES.map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          thresholdType: 'PERCENTAGE',
          threshold,
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
      })),
    });
  }
}
