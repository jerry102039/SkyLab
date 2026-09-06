"""Access rules shared by teaching-resource dependencies."""

from sqlmodel import Session

from app.core.authorizers import (
    can_bypass_resource_ownership,
    require_resource_access,
    require_teaching_access,
)
from app.core.i18n import t
from app.exceptions import NotFoundError, PermissionDeniedError
from app.models import Resource, TeachingClass, TeachingClassStatus, User


def require_vm_teaching_access(
    session: Session,
    user: User,
    vmid: int,
) -> Resource:
    resource = session.get(Resource, vmid)
    if resource is None:
        raise NotFoundError(t("access.resource_not_found", vmid=vmid))
    if can_bypass_resource_ownership(user):
        return resource
    if resource.teaching_class_id is None:
        if resource.allocation_scope == "teaching_class":
            raise PermissionDeniedError(t("access.class_assignment_lost"))
        require_resource_access(user, resource.user_id)
        return resource
    teaching_class = session.get(TeachingClass, resource.teaching_class_id)
    if teaching_class is None:
        raise PermissionDeniedError(t("access.teaching_class_not_found"))
    if resource.user_id == user.id:
        if teaching_class.status != TeachingClassStatus.active:
            raise PermissionDeniedError(
                t("access.resource_not_available_to_students")
            )
        return resource
    require_teaching_access(user, teaching_class.owner_id)
    return resource


__all__ = ["require_vm_teaching_access"]
