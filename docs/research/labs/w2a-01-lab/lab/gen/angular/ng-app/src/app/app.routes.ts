import { Routes } from '@angular/router';
import { Home } from './home';
export const routes: Routes = [
  { path: '', component: Home },
  { path: 'about', loadComponent: () => import('./about').then((m) => m.About) },
];
