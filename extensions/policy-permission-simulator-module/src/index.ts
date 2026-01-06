import { defineModule } from '@directus/extensions-sdk';
import ModuleComponent from './module.vue';

export default defineModule({
	id: 'policy-permission-simulator',
	name: 'Policy Simulator',
	icon: 'policy',
	preRegisterCheck(user) {
		return user.admin_access === true;
	},
	routes: [
		{
			path: '',
			component: ModuleComponent,
		},
	],
});
