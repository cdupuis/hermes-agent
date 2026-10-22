from datetime import timedelta

import pytest

from hermes_sbx import sdk


def test_lifecycle_defaults_to_hibernate_and_resume_in_place():
    options = sdk.lifecycle(lifetime=timedelta(hours=2))
    assert options == {"timeout": timedelta(hours=2), "on_timeout": "restart"}


def test_a_stopped_sandbox_can_be_woken_on_demand():
    assert sdk.lifecycle(lifetime=timedelta(hours=1), on_timeout="stop")["auto_resume"] is True


def test_lifecycle_refuses_unknown_action():
    with pytest.raises(ValueError):
        sdk.lifecycle(lifetime=timedelta(hours=1), on_timeout="explode")


def test_lifecycle_refuses_more_than_cloud_allows():
    with pytest.raises(ValueError, match="lifetime"):
        sdk.lifecycle(lifetime=timedelta(hours=25))
