import { enforceManagedDeployment } from './native-deployment.ts';

enforceManagedDeployment(process.env);
if (process.env.CC_MANAGED_SUPERVISED === '1' && process.send) {
  process.env.CC_MANAGED_POLICY_ENFORCED = '1';
  await import('./main.ts');
} else {
  // This branch is loaded only from the immutable image, never from a state-file executable path.
  await import('./managed-server-main.ts');
}
