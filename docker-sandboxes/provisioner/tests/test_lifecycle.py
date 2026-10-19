from datetime import timedelta

import pytest

from hermes_sbx import sdk


def test_lifecycle_defaults_to_the_only_action_cloud_allows_with_a_volume():
    options = sdk.lifecycle(lifetime=timedelta(hours=2))
    assert options == {"timeout": timedelta(hours=2), "on_timeout": "delete"}


def test_lifecycle_refuses_unknown_action():
    with pytest.raises(ValueError):
        sdk.lifecycle(lifetime=timedelta(hours=1), on_timeout="explode")


def test_lifecycle_refuses_more_than_cloud_allows():
    with pytest.raises(ValueError, match="lifetime"):
        sdk.lifecycle(lifetime=timedelta(hours=25))
