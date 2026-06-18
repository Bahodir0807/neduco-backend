 import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from './roles.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.role) {
      return false;
    }

    const userRole = String(user.role).toLowerCase();
    if ([Role.Admin, Role.Owner, Role.Extra].includes(userRole as Role)) {
      return true;
    }

    return requiredRoles.some((role) => role.toLowerCase() === userRole);
  }
}
